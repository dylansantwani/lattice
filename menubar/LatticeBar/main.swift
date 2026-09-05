import SwiftUI

// LatticeBar — macOS menu-bar usage widget for Lattice.
//
// Architecture mirrors OmniRouteBar's "one source of truth": Lattice's main process computes every
// number (windowed token/cost/timing totals, 30-day activity, per-model / provider / thread / tool
// breakdowns) via the shared aggregator in src/shared/statsSnapshot.ts and mirrors it to
// ~/Library/Application Support/Lattice/stats.json. This app only decodes that JSON and renders, so
// the menu-bar label, the stat cards, the heat-map and the breakdown tables can never disagree with
// the in-app Usage page. When the file is missing or its `appOpen` flag is false (Lattice quit), the
// widget shows the last snapshot marked "Off" rather than a fake live reading.
//
// Build:   swiftc -O -parse-as-library -o LatticeBar main.swift
// QA:      ./LatticeBar --render out.png [--live] [--dark]     (popover → PNG)
//          ./LatticeBar --renderlabel out.png                   (menu-bar label → PNG)

// MARK: - Snapshot models (mirror src/shared/statsSnapshot.ts)

struct StatsWindow: Codable {
    var requests = 0
    var failed = 0
    var freshInputTokens = 0
    var cachedInputTokens = 0
    var cacheReadTokens = 0
    var cacheWriteTokens = 0
    var outputTokens = 0
    var reasoningTokens = 0
    var freshTotalTokens = 0
    var totalTokens = 0
    var toolCalls = 0
    var costUsd = 0.0
    var costEstimated = false
    var costLocal = false
    var wallMs = 0.0
    var ttftMs = 0.0
    var tps = 0
    var cacheHitPct: Double?
    var activeThreads = 0
}

// StatsGroup extends StatsWindow in TS, so the JSON is flat — decode the window fields plus identity.
struct StatsGroup: Codable, Identifiable {
    var key: String
    var label: String
    var sublabel: String?
    var lastAt: Double
    // window fields (flattened)
    var requests = 0
    var failed = 0
    var freshInputTokens = 0
    var cachedInputTokens = 0
    var cacheReadTokens = 0
    var cacheWriteTokens = 0
    var outputTokens = 0
    var reasoningTokens = 0
    var freshTotalTokens = 0
    var totalTokens = 0
    var toolCalls = 0
    var costUsd = 0.0
    var costEstimated = false
    var costLocal = false
    var wallMs = 0.0
    var ttftMs = 0.0
    var tps = 0
    var cacheHitPct: Double?
    var activeThreads = 0
    var id: String { key }
}

struct StatsTool: Codable, Identifiable {
    var tool: String
    var calls: Int
    var failed: Int
    var avgMs: Double?
    var lastAt: Double
    var id: String { tool }
}

struct StatsDay: Codable, Identifiable {
    var date: String
    var weekday: Int
    var requests: Int
    var tokens: Int
    var costUsd: Double
    var id: String { date }
}

struct StatsRange: Codable {
    var window: StatsWindow
    var byModel: [StatsGroup]
    var byProvider: [StatsGroup]
    var byThread: [StatsGroup]
    var tools: [StatsTool]
}

struct StatsRanges: Codable {
    var today: StatsRange
    var d7: StatsRange
    var d30: StatsRange
    var all: StatsRange
    enum CodingKeys: String, CodingKey {
        case today
        case d7 = "7d"
        case d30 = "30d"
        case all
    }
    func range(_ key: RangeKey) -> StatsRange {
        switch key {
        case .today: return today
        case .d7: return d7
        case .d30: return d30
        case .all: return all
        }
    }
}

struct StatsSnapshot: Codable {
    var version: Int
    var generatedAt: Double
    var tz: String
    var appOpen: Bool
    var daily: [StatsDay]
    var ranges: StatsRanges
}

enum RangeKey: String, CaseIterable, Identifiable {
    case today, d7, d30, all
    var id: String { rawValue }
    var label: String {
        switch self {
        case .today: return "Today"
        case .d7: return "7d"
        case .d30: return "30d"
        case .all: return "All"
        }
    }
}

// MARK: - Palette + formatting

// Lattice identity: violet (models / activity) + brass (cost / accents), matching the app's tokens.
let violet     = Color(red: 0.557, green: 0.529, blue: 0.847)   // #8e87d8
let violetSoft = Color(red: 0.667, green: 0.647, blue: 0.914)   // #aaa5e9
let brass      = Color(red: 0.835, green: 0.643, blue: 0.365)   // #d5a45d
let latGrad    = LinearGradient(colors: [violet, brass],
                                startPoint: .topLeading, endPoint: .bottomTrailing)

func abbrev(_ n: Int) -> String {
    let d = Double(n)
    if d >= 1_000_000 { return String(format: "%.2fM", d / 1_000_000) }
    if d >= 1_000 { return String(format: "%.1fK", d / 1_000) }
    return "\(n)"
}

func usd(_ v: Double?) -> String {
    guard let v, v > 0 else { return "—" }
    if v < 0.01 { return String(format: "$%.4f", v) }
    return String(format: "$%.2f", v)
}

func ms(_ v: Double) -> String {
    if v <= 0 { return "—" }
    if v < 1000 { return "\(Int(v.rounded()))ms" }
    return String(format: v < 10000 ? "%.1fs" : "%.0fs", v / 1000)
}

func prettyDay(_ ymd: String) -> String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current
    guard let d = f.date(from: ymd) else { return ymd }
    let o = DateFormatter(); o.dateFormat = "EEE, MMM d"
    return o.string(from: d)
}

func relative(_ d: Date, to now: Date = Date()) -> String {
    if now.timeIntervalSince(d) < 60 { return "just now" }
    let f = RelativeDateTimeFormatter(); f.unitsStyle = .short
    return f.localizedString(for: d, relativeTo: now)
}

// The menu-bar label content, rasterized into a NON-template image (plain text in a MenuBarExtra
// label is otherwise stripped to monochrome).
@MainActor
func statusLabelContent(_ model: UsageModel, labelColor: Color) -> some View {
    HStack(spacing: 4) {
        Image(systemName: "circle.grid.3x3.fill")
        Text(model.compactLabel).fontWeight(.semibold)
    }
    .font(.system(size: 13, design: .rounded))
    .foregroundStyle(labelColor)
    .fixedSize()
}

// MARK: - View model

@MainActor
final class UsageModel: ObservableObject {
    @Published var snapshot: StatsSnapshot?
    @Published var online = false          // file present AND appOpen AND fresh
    @Published var appOpen = false
    @Published var fileDate = Date.distantPast
    @Published var updated = Date.distantPast
    @Published var loadError: String?
    @Published var statusImage: NSImage?

    private var timer: Timer?

    // Default install path; overridable for QA via LATTICEBAR_STATS.
    static func statsPath() -> String {
        if let env = ProcessInfo.processInfo.environment["LATTICEBAR_STATS"], !env.isEmpty { return env }
        let home = ProcessInfo.processInfo.environment["HOME"] ?? "/Users/\(NSUserName())"
        return "\(home)/Library/Application Support/Lattice/stats.json"
    }

    var compactLabel: String {
        guard let s = snapshot else { return "—" }
        return abbrev(s.ranges.today.window.freshTotalTokens)
    }

    func start() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func refresh() {
        let path = Self.statsPath()
        let url = URL(fileURLWithPath: path)
        guard let data = try? Data(contentsOf: url) else {
            online = false
            loadError = "stats.json not found — open Lattice once so it writes usage."
            rebuildStatusImage()
            writeStatus()
            return
        }
        fileDate = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? Date()
        do {
            let s = try JSONDecoder().decode(StatsSnapshot.self, from: data)
            snapshot = s
            appOpen = s.appOpen
            // "Live" only when Lattice says it's open AND the file is fresh (writer ticks every 20s).
            online = s.appOpen && Date().timeIntervalSince(fileDate) < 90
            loadError = nil
            updated = Date()
        } catch {
            online = false
            loadError = "stats.json unreadable: \(error.localizedDescription)"
        }
        rebuildStatusImage()
        writeStatus()
    }

    private func writeStatus() {
        let w = snapshot?.ranges.today.window
        let line = "online=\(online) appOpen=\(appOpen) tokens=\(w?.freshTotalTokens ?? 0) reqs=\(w?.requests ?? 0) failed=\(w?.failed ?? 0) cost=\(usd(w?.costUsd)) err=\(loadError ?? "-")"
        try? line.write(toFile: "/tmp/latticebar.status", atomically: true, encoding: .utf8)
    }

    @MainActor func rebuildStatusImage() {
        let dark = NSApplication.shared.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        let view = statusLabelContent(self, labelColor: dark ? .white : .black).padding(.horizontal, 5)
        let r = ImageRenderer(content: view)
        r.scale = 3
        guard let img = r.nsImage else { return }
        img.isTemplate = false
        statusImage = img
    }
}

// MARK: - Reusable views

struct StatBox: View {
    let title: String; let value: String; let icon: String; let tint: Color
    var sub: String? = nil
    var subTint: Color? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 10, weight: .bold)).foregroundStyle(tint)
                Text(title).font(.system(.caption2, design: .rounded).weight(.semibold)).foregroundStyle(.secondary)
            }
            Text(value).font(.system(size: 20, weight: .bold, design: .rounded)).foregroundStyle(.primary)
                .minimumScaleFactor(0.6).lineLimit(1).contentTransition(.numericText())
            if let sub {
                Text(sub).font(.system(size: 9, design: .rounded).weight(.medium))
                    .foregroundStyle(subTint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.tertiary))
                    .lineLimit(1).minimumScaleFactor(0.75)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(tint.opacity(0.18), lineWidth: 1))
    }
}

struct MiniMetric: View {
    let title: String; let value: String; let icon: String
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 3) {
                Image(systemName: icon).font(.system(size: 8, weight: .bold)).foregroundStyle(.secondary)
                Text(title).font(.system(size: 8.5, design: .rounded).weight(.semibold)).foregroundStyle(.tertiary)
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
            Text(value).font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(.primary)
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 7).padding(.horizontal, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.secondary.opacity(0.08)))
    }
}

struct Card<Content: View>: View {
    let title: String; let icon: String
    var trailing: String? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 11, weight: .bold)).foregroundStyle(.secondary)
                Text(title).font(.system(.caption, design: .rounded).weight(.bold)).tracking(0.5).foregroundStyle(.secondary)
                if let trailing {
                    Spacer()
                    Text(trailing).font(.system(size: 9, design: .rounded)).foregroundStyle(.tertiary)
                }
            }
            content
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color(nsColor: .controlBackgroundColor)))
    }
}

// MARK: - Main popover

struct PopoverView: View {
    @ObservedObject var model: UsageModel
    var forRender = false
    @State private var range: RangeKey = .today
    @State private var hoveredDay: StatsDay? = nil

    private var rangeData: StatsRange? { model.snapshot?.ranges.range(range) }
    private var window: StatsWindow? { rangeData?.window }

    @ViewBuilder private var content: some View {
        VStack(spacing: 12) {
            rangePicker
            statGrid
            miniStrip
            activityCard
            if let rd = rangeData, !rd.byModel.isEmpty { modelsCard(rd) }
            if let rd = rangeData, !rd.byThread.isEmpty { threadsCard(rd) }
            if let rd = rangeData, !rd.tools.isEmpty { toolsCard(rd) }
        }
        .padding(13)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if let e = model.loadError, model.snapshot == nil {
                errorState(e)
            } else if forRender {
                content
            } else {
                ScrollView { content }
            }
            footer
        }
        .frame(width: 420)
        .frame(minHeight: 540, maxHeight: forRender ? nil : 720)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func errorState(_ msg: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "tray").font(.system(size: 26)).foregroundStyle(.tertiary)
            Text(msg).font(.system(size: 11, design: .rounded)).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).frame(maxWidth: 300)
        }
        .frame(maxWidth: .infinity, minHeight: 240)
    }

    private var header: some View {
        HStack(spacing: 9) {
            ZStack {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(latGrad).frame(width: 28, height: 28)
                Image(systemName: "circle.grid.3x3.fill").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("Lattice").font(.system(.headline, design: .rounded).weight(.bold))
                Text(headerSub).font(.system(size: 10, design: .rounded)).foregroundStyle(.secondary)
            }
            Spacer()
            HStack(spacing: 5) {
                Circle().fill(model.online ? .green : (model.appOpen ? .orange : .red)).frame(width: 7, height: 7)
                Text(model.online ? "Live" : (model.snapshot != nil ? "Off" : "—"))
                    .font(.system(.caption2, design: .rounded).weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(.regularMaterial)
    }
    private var headerSub: String {
        let tz = model.snapshot?.tz ?? ""
        return tz.isEmpty ? "usage" : "usage · \(tz) calendar day"
    }

    // Custom segmented control — renders cleanly under headless ImageRenderer (a disabled system
    // segmented Picker draws as a broken placeholder there) and stays interactive in the live popover.
    private var rangePicker: some View {
        HStack(spacing: 0) {
            ForEach(RangeKey.allCases) { r in
                let on = range == r
                Button { range = r; hoveredDay = nil } label: {
                    Text(r.label)
                        .font(.system(size: 11, design: .rounded).weight(on ? .bold : .medium))
                        .foregroundStyle(on ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 5)
                        .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                            .fill(on ? AnyShapeStyle(latGrad) : AnyShapeStyle(.clear)))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.secondary.opacity(0.12)))
    }

    // Four headline cards — the selected window, one source (the snapshot's range).
    private var statGrid: some View {
        let w = window
        let req = w?.requests ?? 0
        let perReq = req > 0 ? (w!.freshTotalTokens / req) : 0
        let failed = w?.failed ?? 0
        let reqSub: String = w == nil ? "no data"
            : failed > 0 ? "\(failed) failed · ≈\(abbrev(perReq))/req"
            : (req > 0 ? "≈\(abbrev(perReq))/req · \(w!.activeThreads) thread\(w!.activeThreads == 1 ? "" : "s")" : "no traffic")
        let hit = w?.cacheHitPct
        return VStack(spacing: 10) {
            HStack(spacing: 10) {
                StatBox(title: "TOKENS", value: abbrev(w?.freshTotalTokens ?? 0), icon: "number", tint: violet,
                        sub: w == nil ? "no data" : "\(abbrev(w!.freshInputTokens))↓ in · \(abbrev(w!.outputTokens))↑ out")
                StatBox(title: "REQUESTS", value: req.formatted(), icon: "arrow.left.arrow.right", tint: violetSoft,
                        sub: reqSub, subTint: failed > 0 ? .orange : nil)
            }
            HStack(spacing: 10) {
                StatBox(title: "CACHE HIT", value: hit == nil ? "—" : String(format: "%.1f%%", hit!),
                        icon: "arrow.triangle.2.circlepath", tint: violet,
                        sub: w == nil ? "no data" : "\(abbrev(w!.cacheReadTokens)) read · \(abbrev(w!.cacheWriteTokens)) written")
                StatBox(title: (w?.costEstimated ?? false) ? "EST. COST" : "COST",
                        value: usd(w?.costUsd), icon: "dollarsign.circle", tint: brass,
                        sub: w == nil ? "no data"
                            : (w!.reasoningTokens > 0 ? "\(abbrev(w!.reasoningTokens)) reasoning tok" : "billed this window"))
            }
        }
    }

    // Secondary throughput / latency / volume metrics.
    private var miniStrip: some View {
        let w = window
        let avgTtft = (w?.requests ?? 0) > 0 ? (w!.ttftMs / Double(w!.requests)) : 0
        return HStack(spacing: 8) {
            MiniMetric(title: "TOK/S", value: (w?.tps ?? 0) > 0 ? "\(w!.tps)" : "—", icon: "speedometer")
            MiniMetric(title: "AVG TTFT", value: ms(avgTtft), icon: "timer")
            MiniMetric(title: "TOOLS", value: (w?.toolCalls ?? 0).formatted(), icon: "hammer.fill")
            MiniMetric(title: "TOTAL TOK", value: abbrev(w?.totalTokens ?? 0), icon: "cylinder.split.1x2.fill")
        }
    }

    // 30-day GitHub-style heat-map, shaded by daily fresh-token volume.
    private var activityCard: some View {
        Card(title: "ACTIVITY · tokens / day", icon: "square.grid.3x3.fill", trailing: "last 30 days") {
            let points = model.snapshot?.daily ?? []
            let maxTokens = max(1, points.map(\.tokens).max() ?? 1)
            let colors: [Color] = [Color.secondary.opacity(0.12), violet.opacity(0.3), violet.opacity(0.5), violet.opacity(0.72), violet]
            let weekdayLabels = ["S", "M", "T", "W", "T", "F", "S"]
            VStack(alignment: .leading, spacing: 8) {
                if points.isEmpty {
                    Text("waiting for traffic…").font(.system(.caption, design: .rounded)).foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, minHeight: 70)
                } else {
                    let lead = points.first?.weekday ?? 0
                    let cells: [StatsDay?] = Array(repeating: nil, count: lead) + points.map { Optional($0) }
                    let weeks: [[StatsDay?]] = stride(from: 0, to: cells.count, by: 7).map {
                        Array(cells[$0..<min($0 + 7, cells.count)])
                    }
                    HStack(alignment: .top, spacing: 4) {
                        VStack(spacing: 4) {
                            ForEach(0..<7, id: \.self) { i in
                                Text(i % 2 == 1 ? weekdayLabels[i] : "")
                                    .font(.system(size: 8, design: .rounded)).foregroundStyle(.tertiary)
                                    .frame(width: 10, height: 15)
                            }
                        }
                        ForEach(Array(weeks.enumerated()), id: \.offset) { _, week in
                            VStack(spacing: 4) {
                                ForEach(0..<7, id: \.self) { di in
                                    if di < week.count, let day = week[di] {
                                        let ratio = Double(day.tokens) / Double(maxTokens)
                                        let level = day.tokens > 0 ? min(4, max(1, Int(ceil(ratio * 4)))) : 0
                                        let isHover = hoveredDay?.date == day.date
                                        RoundedRectangle(cornerRadius: 3).fill(colors[level])
                                            .frame(width: 15, height: 15)
                                            .overlay(RoundedRectangle(cornerRadius: 3)
                                                .stroke(isHover ? Color.primary.opacity(0.9) : .clear, lineWidth: 1.5))
                                            .scaleEffect(isHover ? 1.12 : 1)
                                            .animation(.easeInOut(duration: 0.12), value: isHover)
                                            .onHover { h in
                                                if h { hoveredDay = day } else if hoveredDay?.date == day.date { hoveredDay = nil }
                                            }
                                            .help("\(prettyDay(day.date)) · \(abbrev(day.tokens)) tokens · \(day.requests) req")
                                    } else {
                                        Color.clear.frame(width: 15, height: 15)
                                    }
                                }
                            }
                        }
                    }
                    heatCaption
                }
            }
        }
    }
    @ViewBuilder private var heatCaption: some View {
        if let h = hoveredDay {
            Text("\(prettyDay(h.date)) · \(abbrev(h.tokens)) tokens · \(h.requests) req")
                .font(.system(size: 10, design: .rounded).weight(.semibold)).foregroundStyle(.primary).transition(.opacity)
        } else {
            HStack(spacing: 4) {
                Text("Less").font(.system(size: 9, design: .rounded)).foregroundStyle(.tertiary)
                ForEach(0..<5, id: \.self) { l in
                    let colors: [Color] = [Color.secondary.opacity(0.12), violet.opacity(0.3), violet.opacity(0.5), violet.opacity(0.72), violet]
                    RoundedRectangle(cornerRadius: 2).fill(colors[l]).frame(width: 11, height: 11)
                }
                Text("More").font(.system(size: 9, design: .rounded)).foregroundStyle(.tertiary)
            }
        }
    }

    // Top models by fresh tokens, with a proportional bar.
    private func modelsCard(_ rd: StatsRange) -> some View {
        let rows = Array(rd.byModel.prefix(6))
        let maxTok = max(1, rows.map(\.freshTotalTokens).max() ?? 1)
        return Card(title: "TOP MODELS", icon: "cube.fill", trailing: "fresh tokens") {
            VStack(spacing: 9) {
                ForEach(rows) { m in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Circle().fill(m.costLocal ? Color.secondary.opacity(0.6) : violet).frame(width: 6, height: 6)
                            Text(m.label).font(.system(size: 11, design: .rounded).weight(.medium)).lineLimit(1).truncationMode(.middle)
                            if let sub = m.sublabel {
                                Text(sub).font(.system(size: 9, design: .rounded)).foregroundStyle(.tertiary).lineLimit(1)
                            }
                            Spacer(minLength: 8)
                            Text("\(m.requests)×").font(.system(size: 9, design: .rounded)).foregroundStyle(.tertiary)
                            Text(abbrev(m.freshTotalTokens)).font(.system(size: 11, design: .rounded).weight(.semibold))
                                .foregroundStyle(.secondary).frame(minWidth: 46, alignment: .trailing)
                        }
                        GeometryReader { g in
                            Capsule().fill((m.costLocal ? Color.secondary : violet).opacity(0.35))
                                .frame(width: max(3, g.size.width * CGFloat(m.freshTotalTokens) / CGFloat(maxTok)))
                        }
                        .frame(height: 3)
                    }
                }
            }
        }
    }

    // Most-recent active threads.
    private func threadsCard(_ rd: StatsRange) -> some View {
        let rows = Array(rd.byThread.prefix(5))
        return Card(title: "ACTIVE THREADS", icon: "bubble.left.and.bubble.right.fill", trailing: "recent") {
            VStack(spacing: 8) {
                ForEach(rows) { t in
                    HStack(spacing: 8) {
                        Circle().fill(brass.opacity(0.7)).frame(width: 5, height: 5)
                        Text(t.label).font(.system(size: 11, design: .rounded).weight(.medium)).lineLimit(1).truncationMode(.tail)
                        Spacer(minLength: 8)
                        Text("\(t.requests) req").font(.system(size: 9, design: .rounded)).foregroundStyle(.tertiary)
                        Text(abbrev(t.freshTotalTokens)).font(.system(size: 10, design: .rounded).weight(.semibold))
                            .foregroundStyle(.secondary).frame(minWidth: 44, alignment: .trailing)
                        if t.costUsd > 0 {
                            Text(usd(t.costUsd)).font(.system(size: 9, design: .monospaced)).foregroundStyle(brass)
                                .frame(minWidth: 40, alignment: .trailing)
                        }
                    }
                }
            }
        }
    }

    // Tool usage: calls, failures, mean duration.
    private func toolsCard(_ rd: StatsRange) -> some View {
        let rows = Array(rd.tools.prefix(6))
        let maxCalls = max(1, rows.map(\.calls).max() ?? 1)
        return Card(title: "TOP TOOLS", icon: "hammer.fill", trailing: "calls") {
            VStack(spacing: 9) {
                ForEach(rows) { t in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(t.tool).font(.system(size: 11, design: .rounded).weight(.medium)).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 8)
                            if t.failed > 0 {
                                Text("\(t.failed)✗").font(.system(size: 9, design: .rounded)).foregroundStyle(.red)
                            }
                            if let a = t.avgMs {
                                Text(ms(a)).font(.system(size: 9, design: .rounded)).foregroundStyle(.tertiary)
                            }
                            Text("\(t.calls)").font(.system(size: 11, design: .rounded).weight(.semibold))
                                .foregroundStyle(.secondary).frame(minWidth: 40, alignment: .trailing)
                        }
                        GeometryReader { g in
                            Capsule().fill(brass.opacity(0.32))
                                .frame(width: max(3, g.size.width * CGFloat(t.calls) / CGFloat(maxCalls)))
                        }
                        .frame(height: 3)
                    }
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 6) {
            Button { model.refresh() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.clockwise").font(.system(size: 10, weight: .bold))
                    Text(updatedText).font(.system(.caption2, design: .rounded))
                }
            }.buttonStyle(.plain).foregroundStyle(.secondary)
            Spacer()
            Text("stats.json").font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary)
            Button { NSApp.terminate(nil) } label: { Image(systemName: "power").font(.system(size: 10, weight: .bold)) }
                .buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(.regularMaterial)
    }
    private var updatedText: String {
        if model.updated == .distantPast { return "—" }
        return "updated \(relative(model.updated))"
    }
}

// MARK: - Menu-bar label + app

struct LabelView: View {
    @ObservedObject var model: UsageModel
    @State private var started = false
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "circle.grid.3x3.fill")
            Text(model.compactLabel).fontWeight(.semibold)
        }.onAppear { if !started { started = true; model.start() } }
    }
}

struct LatticeBarApp: App {
    @StateObject private var model = UsageModel()
    var body: some Scene {
        MenuBarExtra {
            PopoverView(model: model)
        } label: {
            if let img = model.statusImage {
                Image(nsImage: img)
            } else {
                LabelView(model: model)
            }
        }
        .menuBarExtraStyle(.window)
    }
}

// Entry point: `--render <path> [--live] [--dark]` draws the popover to a PNG (headless visual QA;
// --live reads the real stats.json, else fixed sample data); `--renderlabel <path>` draws the label.
@main
struct Entry {
    @MainActor static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--render"), i + 1 < args.count {
            renderPNG(to: args[i + 1], live: args.contains("--live"), dark: args.contains("--dark")); return
        }
        if let i = args.firstIndex(of: "--renderlabel"), i + 1 < args.count {
            renderLabel(to: args[i + 1]); return
        }
        LatticeBarApp.main()
    }

    @MainActor static func sampleSnapshot() -> StatsSnapshot {
        func win(_ req: Int, _ failed: Int, _ fin: Int, _ out: Int, _ cr: Int, _ cw: Int, _ cost: Double,
                 _ tps: Int, _ ttft: Double, _ tools: Int, _ reasoning: Int, _ threads: Int, est: Bool = false) -> StatsWindow {
            var w = StatsWindow()
            w.requests = req; w.failed = failed
            w.freshInputTokens = fin; w.outputTokens = out
            w.cacheReadTokens = cr; w.cacheWriteTokens = cw
            w.cachedInputTokens = cr + cw
            w.freshTotalTokens = fin + out
            w.reasoningTokens = reasoning
            w.totalTokens = fin + cr + cw + out + reasoning
            w.toolCalls = tools; w.costUsd = cost; w.costEstimated = est
            w.tps = tps; w.ttftMs = ttft * Double(req); w.wallMs = Double(out) / Double(max(1, tps)) * 1000
            w.activeThreads = threads
            let ti = fin + cr + cw
            w.cacheHitPct = ti > 0 ? (Double(cr + cw) / Double(ti) * 1000).rounded() / 10 : nil
            return w
        }
        func grp(_ key: String, _ label: String, _ sub: String?, _ req: Int, _ fin: Int, _ out: Int,
                 _ cr: Int, _ cost: Double, _ tps: Int, local: Bool = false) -> StatsGroup {
            var g = StatsGroup(key: key, label: label, sublabel: sub, lastAt: Date().timeIntervalSince1970 * 1000)
            g.requests = req; g.freshInputTokens = fin; g.outputTokens = out
            g.cacheReadTokens = cr; g.cachedInputTokens = cr; g.freshTotalTokens = fin + out
            g.costUsd = cost; g.costLocal = local; g.tps = tps
            let ti = fin + cr
            g.cacheHitPct = ti > 0 ? (Double(cr) / Double(ti) * 1000).rounded() / 10 : nil
            return g
        }
        let models = [
            grp("cc/opus", "Claude Opus 4.8", "claude", 214, 1_800_000, 240_000, 22_995_925, 12.40, 96),
            grp("openrouter/glm", "GLM 5.3 Flash", "openrouter", 414, 1_737_000, 140_000, 0, 1.77, 140),
            grp("llamacpp/qwen", "Qwen 3.6 35B", "llama.cpp", 73, 1_552_000, 36_000, 0, 0, 210, local: true)
        ]
        let threads = [
            grp("t1", "Detailed stats + menu-bar app", nil, 88, 820_000, 96_000, 5_100_000, 6.20, 90),
            grp("t2", "Refactor run manager", nil, 41, 402_000, 40_000, 1_713_664, 1.21, 88),
            grp("t3", "Fix cache accounting", nil, 22, 210_000, 24_000, 900_000, 0.40, 92)
        ]
        let tools = [
            StatsTool(tool: "Bash", calls: 342, failed: 7, avgMs: 480, lastAt: 0),
            StatsTool(tool: "Edit", calls: 210, failed: 2, avgMs: 40, lastAt: 0),
            StatsTool(tool: "Read", calls: 188, failed: 0, avgMs: 22, lastAt: 0),
            StatsTool(tool: "Grep", calls: 96, failed: 1, avgMs: 120, lastAt: 0)
        ]
        let today = StatsRange(window: win(214, 3, 3_100_000, 380_000, 45_000_000, 1_600_000, 14.2, 96, 640, 61, 210_000, 5, est: false),
                               byModel: models, byProvider: models, byThread: threads, tools: tools)
        let cal = Calendar.current
        let todayStart = cal.startOfDay(for: Date())
        let sample = [0,0,0,0,0,105_721,0,0,0,196,4_595,0,0,35_013,36_696,0,18_684,0,0,3_494,0,55_154,67_350,5_241,28_517,319_502,1_273_204,2_549_110,3_480_000,0]
        let daily: [StatsDay] = (0..<30).map { i in
            let d = cal.date(byAdding: .day, value: -(29 - i), to: todayStart)!
            let c = cal.dateComponents([.year, .month, .day], from: d)
            let toks = sample[i]
            return StatsDay(date: String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!),
                            weekday: cal.component(.weekday, from: d) - 1, requests: toks / 4900, tokens: toks, costUsd: Double(toks) / 500_000)
        }
        let ranges = StatsRanges(today: today, d7: today, d30: today, all: today)
        return StatsSnapshot(version: 1, generatedAt: Date().timeIntervalSince1970 * 1000, tz: "CDT", appOpen: true, daily: daily, ranges: ranges)
    }

    @MainActor static func renderPNG(to path: String, live: Bool, dark: Bool) {
        let m = UsageModel()
        if live { m.refresh() } else {
            m.snapshot = sampleSnapshot(); m.online = true; m.appOpen = true; m.updated = Date()
        }
        if dark { NSApplication.shared.appearance = NSAppearance(named: .darkAqua) }
        let view = PopoverView(model: m, forRender: true).environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2.0
        guard let img = renderer.nsImage, let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write("render failed\n".data(using: .utf8)!); exit(1)
        }
        try? png.write(to: URL(fileURLWithPath: path))
        print("rendered \(img.size) -> \(path)\(live ? " (live)" : "")\(dark ? " (dark)" : "")")
    }

    @MainActor static func renderLabel(to path: String) {
        let m = UsageModel(); m.snapshot = sampleSnapshot(); m.online = true
        let view = HStack(spacing: 0) {
            statusLabelContent(m, labelColor: .white).padding(.horizontal, 10)
        }.frame(height: 26).background(Color(red: 0.12, green: 0.12, blue: 0.13))
        let r = ImageRenderer(content: view); r.scale = 3.0
        guard let img = r.nsImage, let tiff = img.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
        try? png.write(to: URL(fileURLWithPath: path))
        print("rendered label \(img.size) -> \(path)")
    }
}
