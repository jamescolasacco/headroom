import AppKit

// Headroom Server — the menu-bar app (counterpart of HeadroomServer.exe). It runs the engine
// (`headroom agent`, inside the same app bundle) and shows its settings page in a native window.

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate

// A minimal main menu so standard shortcuts (⌘C/⌘V in text fields, ⌘W, ⌘Q) work in the settings window.
let mainMenu = NSMenu()
let appItem = NSMenuItem()
mainMenu.addItem(appItem)
let appMenu = NSMenu()
appMenu.addItem(withTitle: "About Headroom Server", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
appMenu.addItem(.separator())
appMenu.addItem(withTitle: "Hide Headroom Server", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
appMenu.addItem(.separator())
appMenu.addItem(withTitle: "Quit Headroom Server", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu
let editItem = NSMenuItem()
mainMenu.addItem(editItem)
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
editMenu.addItem(.separator())
editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu
let windowItem = NSMenuItem()
mainMenu.addItem(windowItem)
let windowMenu = NSMenu(title: "Window")
windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
windowItem.submenu = windowMenu
app.mainMenu = mainMenu
app.windowsMenu = windowMenu

app.run()
