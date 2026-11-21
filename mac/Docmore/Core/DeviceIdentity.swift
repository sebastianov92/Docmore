import Foundation

/// What the server and the page know this Mac as. The id is made once and
/// kept in the data directory.
public struct DeviceIdentity: Codable, Equatable, Sendable {
    public let deviceId: String
    public var deviceName: String

    public static func load(from file: URL, defaultName: @autoclosure () -> String) -> DeviceIdentity {
        if let data = try? Data(contentsOf: file),
           var stored = try? JSONDecoder().decode(DeviceIdentity.self, from: data) {
            let name = defaultName()
            if !name.isEmpty { stored.deviceName = name }
            return stored
        }
        let fresh = DeviceIdentity(deviceId: UUID().uuidString.lowercased(), deviceName: defaultName())
        if let data = try? JSONEncoder().encode(fresh) {
            try? AtomicFile.write(data, to: file)
        }
        return fresh
    }
}
