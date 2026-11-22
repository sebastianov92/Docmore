#if DEBUG
import AppKit

/// The automation endpoints of meetings v2: the chooser, the panel with its
/// speakers and its list, and a scripted meeting that goes through the same
/// code a recording does (the live calls to the server included).
@MainActor
enum AutomationMeetings {
    typealias Request = AutomationServer.Request
    typealias Response = AutomationServer.Response

    static func state() -> [String: Any] {
        var answer = MeetingController.shared.automationState
        answer["ok"] = true
        return answer
    }

    /// { show, what?: "panel" | "chooser", mode?, language?, long?, status?, preselected?, error? }:
    /// the panel on a made-up meeting, or the chooser alone. Nothing is
    /// recorded and nothing is sent.
    static func preview(_ request: Request) -> Response {
        let body = request.json
        let controller = MeetingController.shared
        let show = body["show"] as? Bool ?? true
        if (body["what"] as? String) == "chooser" {
            controller.previewChooser(
                show,
                preselected: (body["preselected"] as? String).flatMap(MeetingMode.init(rawValue:)),
                error: body["error"] as? String
            )
        } else if show {
            controller.previewPanel(
                true,
                mode: (body["mode"] as? String).flatMap(MeetingMode.init(rawValue:)) ?? .virtual,
                language: body["language"] as? String ?? "es",
                long: body["long"] as? Bool ?? false,
                status: body["status"] as? String ?? "updated"
            )
        } else {
            controller.previewChooser(false)
            controller.previewPanel(false)
        }
        return .json(["ok": true, "panelVisible": controller.isPanelVisible])
    }

    private static func scriptOptions(_ value: Any) -> ScriptedMeetingEngine.Options? {
        var options = ScriptedMeetingEngine.Options()
        if let values = value as? [String: Any] {
            if let language = values["language"] as? String { options.language = language }
            if let speed = values["speed"] as? Double { options.speed = speed }
            if let stress = values["stress"] as? Bool { options.stress = stress }
            if let audio = values["audio"] as? String { options.audio = URL(fileURLWithPath: audio) }
            return options
        }
        return (value as? Bool) == true ? options : nil
    }

    /// { action, ... }. Actions:
    /// - "start" { mode?, pageId?, spaceId?, title?, profileId?, script?: true | { language?, speed?, stress?, audio? },
    ///   replay?: { file, speed? } }: the same path as the bridge's `meeting.start`; without `mode` the chooser
    ///   opens. `script` records with the engine double; `replay` records with the real engine, fed from a file
    /// - "script" { script: true | false | { ... } }: arms (or disarms) the script for the next recording,
    ///   so a `meeting.start` of the bridge can be followed through the chooser
    /// - "choose" { mode }: a click on a card of the chooser; "cancel": its Cancel
    /// - "rename" { speakerId, name }, "item" { op, id?, kind?, text?, owner?, due? }
    /// - "advance": plays the rest of a scripted meeting; "sync": makes the calls that are due, now
    /// - "stop", "discard"
    /// - "ui" { renaming?, editing?, adding?, transcriptCollapsed?, listCollapsed?, confirmingDiscard?, width?, height?, appearance? }
    /// - "settings" { model?, mode? }; "speaker-model" { scripted?, do?: "download" | "delete" }
    /// Every action answers the state of the meeting.
    static func act(_ request: Request) async -> Response {
        let body = request.json
        let controller = MeetingController.shared
        switch body["action"] as? String ?? "state" {
        case "start":
            guard let profileId = body["profileId"] as? String ?? AppCoordinator.shared.activeProfile?.id else {
                return .error("no account", status: 409)
            }
            var mode: MeetingMode?
            if let text = body["mode"] as? String {
                guard let known = MeetingMode(rawValue: text) else { return .error("mode is in_person or virtual") }
                mode = known
            }
            if let script = body["script"] {
                guard let options = scriptOptions(script) else { return .error("script is true or an object") }
                controller.scriptForNextRecording = options
            }
            if let replay = body["replay"] as? [String: Any] {
                // a real recording played back through the real engine instead of a microphone
                guard let path = replay["file"] as? String, FileManager.default.fileExists(atPath: path) else {
                    return .error("replay needs file: an audio file that exists")
                }
                controller.replayForNextRecording = MeetingReplay(file: URL(fileURLWithPath: path), speed: replay["speed"] as? Double ?? 1)
            }
            do {
                try await controller.start(
                    profileId: profileId,
                    pageId: body["pageId"] as? String,
                    spaceId: body["spaceId"] as? String,
                    title: body["title"] as? String,
                    mode: mode
                )
            } catch {
                controller.scriptForNextRecording = nil
                controller.replayForNextRecording = nil
                return .error(error.localizedDescription, status: 500)
            }

        case "script":
            // the next recording, however it is started (the bridge, the
            // menu), plays the script; { "script": false } takes that back
            if (body["script"] as? Bool) == false {
                controller.scriptForNextRecording = nil
            } else {
                guard let options = scriptOptions(body["script"] ?? true) else { return .error("script is true, false or an object") }
                controller.scriptForNextRecording = options
            }

        case "choose":
            guard let mode = (body["mode"] as? String).flatMap(MeetingMode.init(rawValue:)) else {
                return .error("choose needs mode: in_person or virtual")
            }
            controller.choose(mode)
            // the click answers at once; the recording starts right after
            for _ in 0..<100 where controller.phase == .choosing && controller.chooserError == nil {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }

        case "cancel":
            controller.cancelChoice()

        case "rename":
            guard let speakerId = body["speakerId"] as? String else { return .error("rename needs speakerId") }
            controller.rename(speakerId: speakerId, to: body["name"] as? String)

        case "item":
            let id = body["id"] as? String ?? ""
            let text = body["text"] as? String ?? ""
            let owner = body["owner"] as? String
            let due = body["due"] as? String
            let op: MeetingItemOp
            switch body["op"] as? String ?? "" {
            case "add":
                op = .add(kind: (body["kind"] as? String).flatMap(MeetingItem.Kind.init(rawValue:)) ?? .task, text: text, owner: owner, due: due)
            case "update": op = .update(id: id, text: text, owner: owner, due: due)
            case "cancel": op = .cancel(id: id)
            case "restore": op = .restore(id: id)
            case "remove": op = .remove(id: id)
            default: return .error("item needs op: add, update, cancel, restore or remove")
            }
            guard controller.editItem(op) else { return .error("nothing to do for that edit", status: 409) }

        case "advance":
            controller.advanceScript()
            // what the script said reaches the panel in order, a moment later
            try? await Task.sleep(nanoseconds: 150_000_000)

        case "sync":
            await controller.syncNow()

        case "stop":
            await controller.stop()

        case "discard":
            await controller.discardRecording()

        case "ui":
            if let speaker = body["renaming"] as? String {
                if speaker.isEmpty { controller.renamingSpeakerId = nil } else { controller.beginRename(speaker) }
            }
            if let item = body["editing"] as? String {
                if item.isEmpty { controller.editingItemId = nil } else { controller.beginEdit(item) }
            }
            if let adding = body["adding"] as? Bool {
                if adding { controller.beginAdd() } else { controller.addingItem = false }
            }
            if let collapsed = body["transcriptCollapsed"] as? Bool { controller.transcriptCollapsed = collapsed }
            if let collapsed = body["listCollapsed"] as? Bool { controller.listCollapsed = collapsed }
            if let confirming = body["confirmingDiscard"] as? Bool { controller.confirmingDiscard = confirming }
            if let width = body["width"] as? Double, let height = body["height"] as? Double {
                _ = controller.resizePanel(width: width, height: height)
            }
            if let appearance = body["appearance"] as? String { controller.setPanelAppearance(appearance) }
            // let the panel lay itself out before a snapshot
            try? await Task.sleep(nanoseconds: 250_000_000)

        case "settings":
            let settings = Services.shared.settings
            if let model = body["model"] as? String {
                settings.meetingModel = model
                SettingsModel.shared.meetingModel = model
            }
            if let mode = (body["mode"] as? String).flatMap(MeetingMode.init(rawValue:)) {
                settings.meetingMode = mode
                SettingsModel.shared.meetingMode = mode
            }

        case "speaker-model":
            let model = SettingsModel.shared
            if let scripted = body["scripted"] as? Bool {
                model.engineOverride = scripted ? ScriptedMeetingEngine(base: controller.engine, forSettings: true) : nil
            }
            switch body["do"] as? String ?? "" {
            case "download": model.downloadSpeakerModel()
            case "delete": model.deleteSpeakerModel()
            default: break
            }
            let engine = model.meetingEngine
            var answer = state()
            answer["speakerModel"] = [
                "present": engine.speakerModel != nil,
                "name": engine.speakerModel?.name ?? "",
                "downloaded": engine.isSpeakerModelDownloaded,
                "progress": (model.speakerModelDownload as Any?) ?? NSNull(),
            ]
            return .json(answer)

        case "state":
            break

        default:
            return .error("unknown meeting action")
        }
        return .json(state())
    }
}
#endif
