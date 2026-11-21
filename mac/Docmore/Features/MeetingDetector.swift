import AppKit
import CoreAudio
import WebKit

/// Notices when another app starts using the microphone (a call that just
/// began) and offers to record it. Only the "in use" flag of the input device
/// is read, never the sound, so this needs no permission.
@MainActor
final class MeetingDetector {
    static let shared = MeetingDetector()

    private var enabled = false
    private var device = AudioObjectID(kAudioObjectUnknown)
    private var policy = MicrophoneOfferPolicy()
    private var runningListener: AudioObjectPropertyListenerBlock?
    private var defaultDeviceListener: AudioObjectPropertyListenerBlock?
    private var services: Services { .shared }

    private static var defaultInputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    private static var runningAddress = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    func setEnabled(_ value: Bool) {
        enabled = value
        // a test run feeds the detector by hand instead of watching the hardware
        guard !services.isTestRun else { return }
        if value { attach() } else { detach() }
    }

    private func attach() {
        guard defaultDeviceListener == nil else { return }
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            Task { @MainActor in self?.watchDefaultDevice() }
        }
        defaultDeviceListener = listener
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &Self.defaultInputAddress, .main, listener)
        watchDefaultDevice()
    }

    private func detach() {
        if let listener = defaultDeviceListener {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &Self.defaultInputAddress, .main, listener)
        }
        defaultDeviceListener = nil
        stopWatchingDevice()
    }

    private func stopWatchingDevice() {
        if let listener = runningListener, device != kAudioObjectUnknown {
            AudioObjectRemovePropertyListenerBlock(device, &Self.runningAddress, .main, listener)
        }
        runningListener = nil
        device = AudioObjectID(kAudioObjectUnknown)
    }

    private func watchDefaultDevice() {
        stopWatchingDevice()
        var current = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &Self.defaultInputAddress, 0, nil, &size, &current) == noErr,
              current != kAudioObjectUnknown else { return }
        device = current
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            Task { @MainActor in self?.microphoneStateChanged() }
        }
        runningListener = listener
        AudioObjectAddPropertyListenerBlock(current, &Self.runningAddress, .main, listener)
        // seed the policy with the state right now, without offering anything
        _ = policy.shouldOffer(inUse: isRunning(), appIsCapturing: true, enabled: false)
    }

    private func isRunning() -> Bool {
        guard device != kAudioObjectUnknown else { return false }
        var running: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &Self.runningAddress, 0, nil, &size, &running) == noErr else { return false }
        return running != 0
    }

    private func microphoneStateChanged() {
        evaluate(inUse: isRunning())
    }

    /// True while Docmore itself has the microphone: a recording under way or
    /// a page capturing audio.
    private var appIsCapturing: Bool {
        if MeetingController.shared.isRecording { return true }
        for session in services.liveSessions {
            for webView in session.openWebViews where webView.microphoneCaptureState != .none {
                return true
            }
        }
        return false
    }

    /// The microphone changed state: offer to record when it makes sense.
    func evaluate(inUse: Bool) {
        guard policy.shouldOffer(inUse: inUse, appIsCapturing: appIsCapturing, enabled: enabled) else { return }
        guard let profile = AppCoordinator.shared.activeProfile else { return }
        services.notifications.post(
            title: L("Is a meeting starting?"),
            body: L("Another app is using the microphone. Docmore can record the meeting and write the notes."),
            profileId: profile.id,
            path: nil,
            kind: "meeting-detected"
        )
    }
}
