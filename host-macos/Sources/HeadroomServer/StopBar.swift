import AppKit

/// A small bar at the top of the screen for as long as anyone is connected: who it is, and Stop. It floats above
/// other windows (and full-screen apps) on every Space, so the person here always sees that a session is on and
/// can end it with one click. It can be dragged aside, never closed while the session lasts.
final class StopBar {
    private var panel: NSPanel?
    private let label = NSTextField(labelWithString: "")
    private let dot = NSView()
    private var stopButton: NSButton?
    private var onStop: () -> Void = {}
    private var onOpen: () -> Void = {}

    /// Shows the bar for these people, or hides it when the list is empty.
    func update(_ viewers: [ViewerInfo], host: String, onStop: @escaping () -> Void, onOpen: @escaping () -> Void) {
        self.onStop = onStop
        self.onOpen = onOpen
        guard !viewers.isEmpty else {
            panel?.orderOut(nil)
            return
        }
        let first = viewers[0]
        let who = first.guest ? "“\(first.device)” (guest)" : first.device
        label.stringValue = viewers.count == 1 ? "\(who) is connected to \(host)" : "\(who) and \(viewers.count - 1) other\(viewers.count > 2 ? "s" : "") are connected"
        let p = panel ?? make()
        stopButton?.title = viewers.count == 1 ? "Stop" : "Stop all" // says what it ends
        layout(p)
        if !p.isVisible {
            if let screen = NSScreen.main {
                let f = screen.visibleFrame
                p.setFrameOrigin(NSPoint(x: f.midX - p.frame.width / 2, y: f.maxY - p.frame.height - 8))
            }
            p.orderFrontRegardless()
        }
    }

    private func make() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 40),
                        styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless], backing: .buffered, defer: false)
        p.level = .statusBar
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        p.isMovableByWindowBackground = true
        p.hidesOnDeactivate = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true

        let bg = NSVisualEffectView()
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 12
        bg.layer?.masksToBounds = true
        p.contentView = bg

        dot.wantsLayer = true
        // The on-air lamp (the same amber as the Server window and the website): someone is connected.
        dot.layer?.backgroundColor = NSColor(srgbRed: 0.949, green: 0.663, blue: 0.231, alpha: 1).cgColor
        dot.layer?.cornerRadius = 5
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.lineBreakMode = .byTruncatingTail
        let open = NSButton(title: "Details", target: self, action: #selector(openTapped))
        open.bezelStyle = .rounded
        open.controlSize = .small
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopTapped))
        stop.bezelStyle = .rounded
        stop.controlSize = .small
        stop.hasDestructiveAction = true
        stop.keyEquivalent = ""
        stopButton = stop
        for v in [dot, label, open, stop] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            bg.addSubview(v)
        }
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 10), dot.heightAnchor.constraint(equalToConstant: 10),
            dot.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 14), dot.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8), label.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            open.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 10), open.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            stop.leadingAnchor.constraint(equalTo: open.trailingAnchor, constant: 6), stop.centerYAnchor.constraint(equalTo: bg.centerYAnchor),
            stop.trailingAnchor.constraint(equalTo: bg.trailingAnchor, constant: -10),
        ])
        panel = p
        return p
    }

    private func layout(_ p: NSPanel) {
        let width = min(560, max(360, label.intrinsicContentSize.width + 190))
        if abs(p.frame.width - width) > 1 {
            var f = p.frame
            f.origin.x += (f.width - width) / 2
            f.size.width = width
            p.setFrame(f, display: true)
        }
    }

    @objc private func stopTapped() { onStop() }
    @objc private func openTapped() { onOpen() }
}
