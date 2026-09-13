/**
 * electron-builder afterPack hook: deep ad-hoc code-sign the packaged app.
 *
 * Why this is needed. We build unsigned/unnotarized for local install (`mac.identity: null`), so
 * electron-builder skips signing entirely. What is left behind is the *linker-signed* ad-hoc
 * signature that ships on Electron's own binary — it still says `Identifier=Electron`, it is not
 * bound to our Info.plist, and it does not cover the resources we just added, so
 * `codesign --verify` fails. On Apple Silicon every executable must carry a valid signature, so
 * that bundle is at best fragile and at worst killed on launch.
 *
 * Re-signing ad-hoc (`-s -`) fixes all of it and needs no certificate: nested code first, then the
 * bundle itself, so each signature covers the already-signed contents beneath it. This runs before
 * the DMG is built, so the DMG carries the signed app too.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const sign = (target) =>
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], { stdio: 'pipe' })

/** Depth-first: frameworks and helper apps must be signed before the app that contains them. */
function signNested(appPath) {
  const fw = join(appPath, 'Contents', 'Frameworks')
  if (!existsSync(fw)) return
  for (const name of readdirSync(fw)) {
    const p = join(fw, name)
    if (name.endsWith('.app')) {
      signNested(p)
      sign(p)
    } else if (name.endsWith('.framework') || name.endsWith('.dylib') || name.endsWith('.node')) {
      sign(p)
    }
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  signNested(appPath)
  sign(appPath)
  // Fail the build rather than shipping a bundle that will not launch.
  execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'pipe' })
  console.log(`  • ad-hoc signed and verified  app=${appPath}`)
}
