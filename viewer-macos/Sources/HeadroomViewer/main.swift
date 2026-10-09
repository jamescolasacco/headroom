import AppKit

// Headroom Viewer — connect to your Headroom computers (counterpart of HeadroomViewer.exe).
//
// Menu shortcuts only fire when the page doesn't take the key: during a session the client claims ⌘W, ⌘Q, ⌘N…
// for the remote computer (like a keyboard plugged into it), so use the menus or Ctrl+Alt+Shift+Q to leave.

let app = NSApplication.shared
app.delegate = AppDelegate.shared

func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
    let top = NSMenuItem()
    let m = NSMenu(title: title)
    items.forEach(m.addItem)
    top.submenu = m
    return top
}

func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.keyEquivalentModifierMask = mods
    i.target = target
    return i
}

let mainMenu = NSMenu()
mainMenu.addItem(menu("Headroom Viewer", [
    item("About Headroom Viewer", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
    .separator(),
    item("Hide Headroom Viewer", #selector(NSApplication.hide(_:)), "h"),
    item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
    item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
    .separator(),
    item("Quit Headroom Viewer", #selector(NSApplication.terminate(_:)), "q"),
]))
mainMenu.addItem(menu("File", [
    item("New Window", #selector(AppDelegate.newWindow(_:)), "n", target: AppDelegate.shared),
    item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
]))
mainMenu.addItem(menu("Edit", [
    item("Undo", Selector(("undo:")), "z"),
    item("Redo", Selector(("redo:")), "z", [.command, .shift]),
    .separator(),
    item("Cut", #selector(NSText.cut(_:)), "x"),
    item("Copy", #selector(NSText.copy(_:)), "c"),
    item("Paste", #selector(NSText.paste(_:)), "v"),
    item("Select All", #selector(NSText.selectAll(_:)), "a"),
]))
mainMenu.addItem(menu("View", [
    item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
]))
let windowMenu = menu("Window", [
    item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
    item("Zoom", #selector(NSWindow.performZoom(_:))),
])
mainMenu.addItem(windowMenu)
app.mainMenu = mainMenu
app.windowsMenu = windowMenu.submenu

app.run()
