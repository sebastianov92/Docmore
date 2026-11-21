import AudioToolbox
import CoreAudio
import Foundation

/// Everything the Mac plays, through a Core Audio process tap
/// (`CATapDescription` + `AudioHardwareCreateProcessTap`) read through a
/// private aggregate device. macOS 14.4 and later.
///
/// The first time the tap delivers audio the system asks the person for
/// "Screen & System Audio Recording" (the app needs
/// `NSAudioCaptureUsageDescription`). Until the person allows it, and for
/// good if they refuse, the tap delivers silence and no error: the recorder
/// reports a silent source at the end.
final class SystemAudioCapture: AudioCaptureSource {
    let kind = AudioSource.systemAudio
    var onEnded: ((MeetingRecorderError) -> Void)?

    private let lock = NSLock()
    private var handler: (([Float], Double) -> Void)?
    private var format = AudioStreamBasicDescription()
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var formatListener: AudioObjectPropertyListenerBlock?
    private let ioQueue = DispatchQueue(label: "com.dezik.meetingkit.system-audio", qos: .userInitiated)

    func start(handler: @escaping ([Float], Double) -> Void) async throws {
        if SystemAudioPermission.status() == .denied {
            throw MeetingRecorderError.systemAudioPermissionDenied
        }
        lock.withLock { self.handler = handler }
        do {
            try createTap()
            do {
                // the documented way: a private aggregate device that holds only the tap
                try createAggregateDevice(mainSubDeviceUID: nil)
                try startIO()
            } catch {
                // the other known way: the tap next to the default output device, which gives the clock
                destroyAggregateDevice()
                guard let outputUID = Self.defaultOutputDeviceUID() else { throw error }
                try createAggregateDevice(mainSubDeviceUID: outputUID)
                try startIO()
            }
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        destroyAggregateDevice()
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            if let formatListener {
                var address = Self.address(kAudioTapPropertyFormat)
                AudioObjectRemovePropertyListenerBlock(tapID, &address, ioQueue, formatListener)
            }
            AudioHardwareDestroyProcessTap(tapID)
        }
        tapID = AudioObjectID(kAudioObjectUnknown)
        formatListener = nil
        lock.lock()
        handler = nil
        lock.unlock()
    }

    // MARK: - Tap

    private var tapUID = UUID()

    private func createTap() throws {
        // All processes, mixed down to stereo, without this app's own sound.
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: Self.ownProcessObject().map { [$0] } ?? [])
        tapUID = UUID()
        description.uuid = tapUID
        description.name = "Docmore meeting"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        var tap = AudioObjectID(kAudioObjectUnknown)
        let status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr, tap != AudioObjectID(kAudioObjectUnknown) else {
            throw MeetingRecorderError.systemAudioUnavailable("the audio tap could not be created (\(Self.describe(status)))")
        }
        tapID = tap
        try readTapFormat()
        // the format follows the output device (48 kHz speakers, 44.1 kHz headphones)
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            try? self?.readTapFormat()
        }
        var address = Self.address(kAudioTapPropertyFormat)
        if AudioObjectAddPropertyListenerBlock(tap, &address, ioQueue, listener) == noErr {
            formatListener = listener
        }
    }

    private func readTapFormat() throws {
        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = Self.address(kAudioTapPropertyFormat)
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &description)
        guard status == noErr, description.mSampleRate > 0 else {
            throw MeetingRecorderError.systemAudioUnavailable("the audio tap has no format (\(Self.describe(status)))")
        }
        guard AudioMath.isFloat32(description) else {
            throw MeetingRecorderError.systemAudioUnavailable("the audio tap delivers a sample format that is not 32-bit float")
        }
        lock.lock()
        format = description
        lock.unlock()
    }

    // MARK: - Aggregate device

    private func createAggregateDevice(mainSubDeviceUID: String?) throws {
        var description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Docmore meeting capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
        ]
        if let mainSubDeviceUID {
            description[kAudioAggregateDeviceMainSubDeviceKey] = mainSubDeviceUID
            description[kAudioAggregateDeviceSubDeviceListKey] = [[kAudioSubDeviceUIDKey: mainSubDeviceUID]]
            description[kAudioAggregateDeviceTapListKey] = [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: tapUID.uuidString,
            ]]
        }
        var device = AudioObjectID(kAudioObjectUnknown)
        var status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &device)
        guard status == noErr, device != AudioObjectID(kAudioObjectUnknown) else {
            throw MeetingRecorderError.systemAudioUnavailable("the capture device could not be created (\(Self.describe(status)))")
        }
        aggregateID = device
        if mainSubDeviceUID == nil {
            var address = Self.address(kAudioAggregateDevicePropertyTapList)
            var taps = [tapUID.uuidString] as CFArray
            status = withUnsafePointer(to: &taps) { pointer in
                AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<CFArray>.size), pointer)
            }
            guard status == noErr else {
                throw MeetingRecorderError.systemAudioUnavailable("the audio tap could not be attached (\(Self.describe(status)))")
            }
        }
    }

    private func startIO() throws {
        var proc: AudioDeviceIOProcID?
        var status = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateID, ioQueue) { [weak self] _, input, _, _, _ in
            self?.deliver(input)
        }
        guard status == noErr, let proc else {
            throw MeetingRecorderError.systemAudioUnavailable("the capture callback could not be installed (\(Self.describe(status)))")
        }
        procID = proc
        status = AudioDeviceStart(aggregateID, proc)
        guard status == noErr else {
            throw MeetingRecorderError.systemAudioUnavailable("the capture device did not start (\(Self.describe(status)))")
        }
    }

    private func destroyAggregateDevice() {
        guard aggregateID != AudioObjectID(kAudioObjectUnknown) else { return }
        if let procID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        AudioHardwareDestroyAggregateDevice(aggregateID)
        procID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
    }

    private func deliver(_ list: UnsafePointer<AudioBufferList>) {
        lock.lock()
        let handler = self.handler
        let format = self.format
        lock.unlock()
        guard let handler else { return }
        let mono = AudioMath.mono(from: list, format: format)
        if !mono.isEmpty { handler(mono, format.mSampleRate) }
    }

    // MARK: - Core Audio helpers

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    /// The Core Audio object of this process, to keep its own sound out.
    private static func ownProcessObject() -> AudioObjectID? {
        var address = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var pid = getpid()
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address,
            UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object
        )
        guard status == noErr, object != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return object
    }

    private static func defaultOutputDeviceUID() -> String? {
        var address = address(kAudioHardwarePropertyDefaultOutputDevice)
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != AudioObjectID(kAudioObjectUnknown) else { return nil }
        var uidAddress = Self.address(kAudioDevicePropertyDeviceUID)
        var uid: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &size, &uid) == noErr, let uid else { return nil }
        return uid.takeRetainedValue() as String
    }

    /// OSStatus as a four character code when it is one ("!obj"), else the number.
    static func describe(_ status: OSStatus) -> String {
        let value = UInt32(bitPattern: status)
        let bytes = [UInt8(value >> 24 & 0xFF), UInt8(value >> 16 & 0xFF), UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF)]
        if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) {
            return "'" + String(decoding: bytes, as: UTF8.self) + "'"
        }
        return String(status)
    }
}

/// The state of "Screen & System Audio Recording" for this app.
///
/// macOS has no public call for it. The private `TCCAccessPreflight` (looked
/// up at run time, never linked) answers without showing a dialog. When it
/// is missing, or when `MeetingRecorder.usesPrivatePermissionCheck` is off,
/// the answer is `.undetermined` and the only way to know is to record.
enum SystemAudioPermission {
    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int

    private static let preflight: Preflight? = {
        guard let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
              let symbol = dlsym(handle, "TCCAccessPreflight") else { return nil }
        return unsafeBitCast(symbol, to: Preflight.self)
    }()

    static func status() -> PermissionStatus {
        guard MeetingRecorder.usesPrivatePermissionCheck, let preflight else { return .undetermined }
        // 0 granted, 1 denied, 2 not asked yet
        switch preflight("kTCCServiceAudioCapture" as CFString, nil) {
        case 0: return .granted
        case 1: return .denied
        default: return .undetermined
        }
    }
}
