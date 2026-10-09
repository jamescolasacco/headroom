import ApplicationServices
import CoreGraphics
import Foundation

/// The two macOS privacy permissions the host needs. Both are granted per app in System Settings →
/// Privacy & Security; the menu-bar app walks the user through them.
public enum Permissions {
    public static let screenRecordingHint =
        "Screen Recording is off for Headroom. Turn it on in System Settings → Privacy & Security → Screen & System Audio Recording, then restart Headroom Server."
    public static let accessibilityHint =
        "Remote control needs the Accessibility permission. Turn on Headroom in System Settings → Privacy & Security → Accessibility."

    public static var screenRecording: Bool { CGPreflightScreenCaptureAccess() }
    public static var accessibility: Bool { AXIsProcessTrusted() }

    /// Shows the system prompt (once per launch at most; macOS ignores repeats).
    @discardableResult
    public static func requestScreenRecording() -> Bool { CGRequestScreenCaptureAccess() }

    @discardableResult
    public static func requestAccessibility() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    public static let screenRecordingSettingsUrl = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    public static let accessibilitySettingsUrl = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

    public static var json: JSONObject {
        ["screenRecording": screenRecording, "accessibility": accessibility,
         "screenRecordingUrl": screenRecordingSettingsUrl, "accessibilityUrl": accessibilitySettingsUrl]
    }
}
