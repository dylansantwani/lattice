import React from 'react'

interface Props {
  children: React.ReactNode
  /** short label for what failed, e.g. "the transcript" */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * Catches render/runtime errors in a subtree and shows a recoverable fallback instead of letting
 * one broken component unmount the entire app. Without this, a single throw (a missing component,
 * a bad message shape) blanks the whole window — including the composer and its `/` commands.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface it in the devtools console; the fallback keeps the rest of the app usable.
    console.error(`Lattice: ${this.props.label ?? 'a panel'} crashed`, error, info)
  }

  reset = (): void => this.setState({ error: null })

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="error-fallback" role="alert">
          <div className="error-fallback-title">Something in {this.props.label ?? 'this panel'} broke.</div>
          <div className="error-fallback-msg">{this.state.error.message}</div>
          <button className="mini-btn" onClick={this.reset}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
