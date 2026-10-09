import AppKit

/// The menu-bar glyph: the Headroom logo (screen + check) as a template image, so macOS tints it for light
/// and dark menu bars. While someone is connected, a filled dot sits on the screen's corner (like the
/// Windows tray icon's green badge, but in the menu bar's monochrome style).
enum StatusIcon {
    static func image(active: Bool, warning: Bool = false) -> NSImage {
        let size = NSSize(width: 20, height: 16)
        let img = NSImage(size: size, flipped: true) { _ in
            NSColor.black.set()
            let screen = NSBezierPath(roundedRect: NSRect(x: 2, y: 1.5, width: 15, height: 10.5), xRadius: 2.2, yRadius: 2.2)
            screen.lineWidth = 1.5
            screen.stroke()
            let base = NSBezierPath()
            base.move(to: NSPoint(x: 6.5, y: 14.5))
            base.line(to: NSPoint(x: 12.5, y: 14.5))
            base.lineWidth = 1.5
            base.lineCapStyle = .round
            base.stroke()
            if warning {
                // "!" — needs attention (permission missing / server stopped)
                let bar = NSBezierPath()
                bar.move(to: NSPoint(x: 9.5, y: 4.2))
                bar.line(to: NSPoint(x: 9.5, y: 7.6))
                bar.lineWidth = 1.6
                bar.lineCapStyle = .round
                bar.stroke()
                NSBezierPath(ovalIn: NSRect(x: 8.7, y: 8.8, width: 1.6, height: 1.6)).fill()
            } else {
                let check = NSBezierPath()
                check.move(to: NSPoint(x: 6.6, y: 6.9))
                check.line(to: NSPoint(x: 8.8, y: 9.0))
                check.line(to: NSPoint(x: 12.6, y: 4.8))
                check.lineWidth = 1.6
                check.lineCapStyle = .round
                check.lineJoinStyle = .round
                check.stroke()
            }
            if active {
                // Knock out a ring, then draw the dot.
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(ovalIn: NSRect(x: 12.5, y: 7.5, width: 8, height: 8)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                NSBezierPath(ovalIn: NSRect(x: 14, y: 9, width: 5, height: 5)).fill()
            }
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = active ? "Headroom Server — viewer connected" : "Headroom Server"
        return img
    }
}
