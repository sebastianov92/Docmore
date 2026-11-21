import AVFoundation
import CoreAudio
import Foundation
import MeetingKitObjC

/// A device that delivers audio to the recorder.
protocol AudioCaptureSource: AnyObject {
    var kind: AudioSource { get }
    /// Called (from any thread) when the source stops for good on its own.
    var onEnded: ((MeetingRecorderError) -> Void)? { get set }
    /// Starts capturing. `handler` gets blocks of mono Float32 and their
    /// sample rate, from any thread.
    func start(handler: @escaping ([Float], Double) -> Void) async throws
    func stop()
}

/// The default input device, through `AVAudioEngine`.
final class MicrophoneCapture: AudioCaptureSource {
    let kind = AudioSource.microphone
    var onEnded: ((MeetingRecorderError) -> Void)?

    private let lock = NSLock()
    private var engine: AVAudioEngine?
    private var handler: (([Float], Double) -> Void)?
    private var observer: NSObjectProtocol?
    private let restartQueue = DispatchQueue(label: "com.dezik.meetingkit.microphone")

    func start(handler: @escaping ([Float], Double) -> Void) async throws {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            // shows the system dialog and waits for the answer
            guard await AVCaptureDevice.requestAccess(for: .audio) else {
                throw MeetingRecorderError.microphonePermissionDenied
            }
        default:
            throw MeetingRecorderError.microphonePermissionDenied
        }
        guard Self.hasInputDevice() else {
            throw MeetingRecorderError.microphoneUnavailable("no input device is connected")
        }
        lock.withLock { self.handler = handler }
        try startEngine()
    }

    func stop() {
        lock.lock()
        let engine = self.engine
        let observer = self.observer
        self.engine = nil
        self.observer = nil
        handler = nil
        lock.unlock()
        if let observer { NotificationCenter.default.removeObserver(observer) }
        if let engine { Self.tearDown(engine) }
    }

    private func startEngine() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw MeetingRecorderError.microphoneUnavailable("the input device has no usable format")
        }
        var raised: NSError?
        let installed = MKTryBlock({
            input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
                guard let self else { return }
                self.lock.lock()
                let handler = self.handler
                self.lock.unlock()
                guard let handler else { return }
                let mono = AudioMath.mono(from: buffer)
                if !mono.isEmpty { handler(mono, buffer.format.sampleRate) }
            }
            engine.prepare()
        }, &raised)
        guard installed else {
            throw MeetingRecorderError.microphoneUnavailable(raised?.localizedDescription ?? "the audio engine refused the input format")
        }
        do {
            try engine.start()
        } catch {
            Self.tearDown(engine)
            throw MeetingRecorderError.microphoneUnavailable(error.localizedDescription)
        }
        // Another microphone, AirPods connecting, a sample rate change: the
        // engine stops by itself and has to be built again.
        let observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.restartQueue.async { self?.restartAfterConfigurationChange() }
        }
        lock.lock()
        self.engine = engine
        self.observer = observer
        lock.unlock()
    }

    private func restartAfterConfigurationChange() {
        lock.lock()
        let old = engine
        let oldObserver = observer
        let running = handler != nil
        engine = nil
        observer = nil
        lock.unlock()
        if let oldObserver { NotificationCenter.default.removeObserver(oldObserver) }
        if let old { Self.tearDown(old) }
        guard running else { return }
        guard Self.hasInputDevice() else {
            onEnded?(.microphoneUnavailable("the input device was disconnected"))
            return
        }
        do {
            try startEngine()
        } catch let error as MeetingRecorderError {
            onEnded?(error)
        } catch {
            onEnded?(.microphoneUnavailable(error.localizedDescription))
        }
    }

    private static func tearDown(_ engine: AVAudioEngine) {
        var ignored: NSError?
        _ = MKTryBlock({
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }, &ignored)
    }

    /// True when the system has a default input device.
    static func hasInputDevice() -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        return status == noErr && device != AudioObjectID(kAudioObjectUnknown)
    }
}
