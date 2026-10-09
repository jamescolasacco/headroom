import Darwin
import Foundation
import SystemConfiguration

public enum HostInfo {
    public static let version: String = {
        if let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, !v.isEmpty { return v }
        return "0.1.0"
    }()

    /// The Mac's user-visible name (System Settings → General → About → Name), e.g. "Sam's MacBook Pro".
    public static var machineName: String {
        if let n = SCDynamicStoreCopyComputerName(nil, nil) as String?, !n.isEmpty { return n }
        return ProcessInfo.processInfo.hostName
    }

    /// Bonjour host name without ".local" (e.g. "Sams-MacBook-Pro").
    public static var localHostName: String {
        if let n = SCDynamicStoreCopyLocalHostName(nil) as String?, !n.isEmpty { return n }
        return machineName.replacingOccurrences(of: " ", with: "-")
    }

    public static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    public static var hostId: String {
        if let id = ConfigStore.current.hostId { return id }
        let id = Bytes.base64Url(Bytes.random(12))
        ConfigStore.update { if $0.hostId == nil { $0.hostId = id } }
        return ConfigStore.current.hostId ?? id
    }

    public static var name: String {
        if let n = ConfigStore.current.displayName, !n.trimmingCharacters(in: .whitespaces).isEmpty { return n }
        return machineName
    }

    public static func describe() -> JSONObject {
        ["id": hostId, "name": name, "machine": machineName, "os": "macos", "osVersion": osVersion, "version": version]
    }
}

public enum NetInterfaces {
    public struct Address: Hashable {
        public let text: String
        public let isV4: Bool
        public let interface: String
    }

    /// Addresses of interfaces that are up, excluding loopback and IPv6 link-local/multicast.
    public static func localAddresses() -> [Address] {
        var result = [Address]()
        var ifap: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifap) == 0, let first = ifap else { return result }
        defer { freeifaddrs(ifap) }
        var seen = Set<String>()
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = p.pointee
            let flags = Int32(ifa.ifa_flags)
            guard (flags & IFF_UP) != 0, (flags & IFF_LOOPBACK) == 0, let sa = ifa.ifa_addr else { continue }
            let family = Int32(sa.pointee.sa_family)
            let name = String(cString: ifa.ifa_name)
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if family == AF_INET {
                guard getnameinfo(sa, socklen_t(MemoryLayout<sockaddr_in>.size), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
                let s = String(cString: host)
                if s.hasPrefix("169.254.") { continue } // self-assigned: never reachable, churns the certificate
                if seen.insert(s).inserted { result.append(Address(text: s, isV4: true, interface: name)) }
            } else if family == AF_INET6 {
                guard getnameinfo(sa, socklen_t(MemoryLayout<sockaddr_in6>.size), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
                var s = String(cString: host)
                if let pct = s.firstIndex(of: "%") { s = String(s[..<pct]) }
                let lower = s.lowercased()
                if lower.hasPrefix("fe8") || lower.hasPrefix("fe9") || lower.hasPrefix("fea") || lower.hasPrefix("feb") || lower.hasPrefix("ff") { continue }
                if seen.insert(s).inserted { result.append(Address(text: s, isV4: false, interface: name)) }
            }
        }
        return result
    }

    public static func ipv4Addresses() -> [String] {
        // Physical/Wi-Fi interfaces first (en*), then the rest (Tailscale utun, bridges).
        let v4 = localAddresses().filter { $0.isV4 }
        return v4.filter { $0.interface.hasPrefix("en") }.map(\.text) + v4.filter { !$0.interface.hasPrefix("en") }.map(\.text)
    }

    /// Normalises "::ffff:192.168.1.5" to "192.168.1.5".
    public static func normalize(_ ip: String) -> String {
        let l = ip.lowercased()
        if l.hasPrefix("::ffff:"), l.contains(".") { return String(ip.dropFirst(7)) }
        return ip
    }

    public static func isLoopback(_ ip: String?) -> Bool {
        guard let ip else { return false }
        let n = normalize(ip)
        return n == "::1" || n.hasPrefix("127.")
    }

    /// True if the address belongs to this Mac (viewer running on the host itself).
    public static func isLocal(_ ip: String?) -> Bool {
        guard let ip else { return false }
        if isLoopback(ip) { return true }
        let n = normalize(ip)
        return localAddresses().contains { $0.text == n }
    }
}
