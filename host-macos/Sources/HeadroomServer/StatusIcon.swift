import AppKit

/// The menu-bar glyph: the Headroom mark (a screen with its top edge lit) as a template image, so macOS tints it
/// for light and dark menu bars. While someone is connected, a filled dot sits on the screen's corner (the Windows
/// tray icon's warm lamp, in the menu bar's monochrome style).
enum StatusIcon {
    static func image(active: Bool, warning: Bool = false) -> NSImage {
        let size = NSSize(width: 20, height: 16)
        let img = NSImage(size: size, flipped: true) { _ in
            NSColor.black.set()
            let screen = NSBezierPath(roundedRect: NSRect(x: 2, y: 2.5, width: 16, height: 11), xRadius: 2.6, yRadius: 2.6)
            screen.lineWidth = 1.5
            screen.stroke()
            if warning {
                // "!": needs attention (permission missing / server stopped)
                let bar = NSBezierPath()
                bar.move(to: NSPoint(x: 10, y: 5.2))
                bar.line(to: NSPoint(x: 10, y: 8.4))
                bar.lineWidth = 1.6
                bar.lineCapStyle = .round
                bar.stroke()
                NSBezierPath(ovalIn: NSRect(x: 9.2, y: 9.6, width: 1.6, height: 1.6)).fill()
            } else {
                // the lit top edge
                NSBezierPath(roundedRect: NSRect(x: 4.8, y: 5.2, width: 10.4, height: 2.2), xRadius: 1.1, yRadius: 1.1).fill()
            }
            if active {
                // Knock out a ring, then draw the dot.
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(ovalIn: NSRect(x: 12.5, y: 8, width: 8, height: 8)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                NSBezierPath(ovalIn: NSRect(x: 14, y: 9.5, width: 5, height: 5)).fill()
            }
            return true
        }
        img.isTemplate = true
        img.accessibilityDescription = active ? "Headroom Server — viewer connected" : "Headroom Server"
        return img
    }
}
