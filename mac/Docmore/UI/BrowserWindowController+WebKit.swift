import AppKit
import UniformTypeIdentifiers
import WebKit

// Navigation, new windows, downloads, file pickers and media permission.
extension BrowserWindowController: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var serverHost: String? { session.serverURL.host?.lowercased() }

    private func isOwnServer(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return url.host?.lowercased() == serverHost && url.port == session.serverURL.port
    }

    /// A link to the server itself is a link into the app.
    private func appPath(forServerURL url: URL) -> String? {
        guard isOwnServer(url), let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if path.hasPrefix("/api/") { return nil }
        if let query = components.percentEncodedQuery, !query.isEmpty { path += "?" + query }
        if let fragment = components.percentEncodedFragment, !fragment.isEmpty { path += "#" + fragment }
        return path
    }

    private func pathOf(appURL url: URL) -> String {
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        var path = components?.percentEncodedPath ?? "/"
        if path.isEmpty { path = "/" }
        if let query = components?.percentEncodedQuery, !query.isEmpty { path += "?" + query }
        if let fragment = components?.percentEncodedFragment, !fragment.isEmpty { path += "#" + fragment }
        return path
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, preferences: WKWebpagePreferences, decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.cancel, preferences)
            return
        }
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        let opensNewWindow = navigationAction.targetFrame == nil

        switch scheme {
        case AppScheme.name:
            guard url.host == session.profileId else {
                decisionHandler(.cancel, preferences)
                return
            }
            if navigationAction.shouldPerformDownload {
                decisionHandler(.cancel, preferences)
                saveFromServer(path: pathOf(appURL: url), suggestedName: nil)
            } else if opensNewWindow {
                decisionHandler(.cancel, preferences)
                AppCoordinator.shared.openTab(in: self, path: pathOf(appURL: url))
            } else {
                decisionHandler(.allow, preferences)
            }
        case "about", "blob", "data":
            if navigationAction.shouldPerformDownload {
                decisionHandler(.download, preferences)
            } else {
                decisionHandler(.allow, preferences)
            }
        case "http", "https":
            if !isMainFrame, !opensNewWindow {
                // embeds (video, diagrams) load inside their frame
                decisionHandler(.allow, preferences)
            } else if let path = appPath(forServerURL: url) {
                decisionHandler(.cancel, preferences)
                if opensNewWindow {
                    AppCoordinator.shared.openTab(in: self, path: path)
                } else {
                    navigate(to: path)
                }
            } else {
                decisionHandler(.cancel, preferences)
                Services.shared.openExternal(url)
            }
        case AppScheme.deepLink:
            decisionHandler(.cancel, preferences)
            AppCoordinator.shared.handleDeepLink(url)
        default:
            // mailto:, tel:, other apps
            decisionHandler(.cancel, preferences)
            Services.shared.openExternal(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let response = navigationResponse.response
        let url = response.url
        let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        let wantsDownload = !navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment")
        guard wantsDownload else {
            decisionHandler(.allow)
            return
        }
        if let url, url.scheme == AppScheme.name {
            // the download machinery of WebKit does not reach the app's own scheme
            decisionHandler(.cancel)
            saveFromServer(path: pathOf(appURL: url), suggestedName: response.suggestedFilename)
        } else {
            decisionHandler(.download)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        pageLoaded = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        AppCoordinator.shared.scheduleStateSave()
        // a page that just came up learns where the network stands
        session.emit("net.changed", ["reachable": session.reachability.reachable], to: webView)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        pageLoaded = true
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        // cancelled navigations (a link handed to the browser, a download) are not failures
        if code == NSURLErrorCancelled || code == 102 { return }
        pageLoaded = true
        NSLog("Docmore: navigation failed: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageLoaded = false
        webView.reload()
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if url.scheme == AppScheme.name, url.host == session.profileId {
            AppCoordinator.shared.openTab(in: self, path: pathOf(appURL: url))
        } else if let path = appPath(forServerURL: url) {
            AppCoordinator.shared.openTab(in: self, path: path)
        } else if let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) {
            Services.shared.openExternal(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard let window else { return completionHandler() }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: L("OK"))
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard let window else { return completionHandler(false) }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: L("OK"))
        alert.addButton(withTitle: L("Cancel"))
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard let window else { return completionHandler(nil) }
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: L("OK"))
        alert.addButton(withTitle: L("Cancel"))
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    /// `<input type="file">`
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard let window else { return completionHandler(nil) }
        #if DEBUG
        if AutomationServer.isEnabled, let preset = ProcessInfo.processInfo.environment["DOCMORE_AUTOMATION_OPEN_FILE"] {
            completionHandler([URL(fileURLWithPath: preset)])
            return
        }
        #endif
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// `getUserMedia`: the page belongs to the app, so the app says yes; the
    /// system's own microphone or camera prompt is still the person's to answer.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let ownPage = origin.protocol == AppScheme.name && origin.host == session.profileId
        decisionHandler(ownPage ? .grant : .prompt)
    }

    // MARK: WKDownloadDelegate (blob: and http downloads)

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        chooseDestination(suggestedName: suggestedFilename) { url in
            if let url {
                // WebKit refuses to write over a file; the save panel already asked
                try? FileManager.default.removeItem(at: url)
            }
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        presentError(L("The download failed"), detail: error.localizedDescription)
    }

    private func chooseDestination(suggestedName: String, completion: @escaping (URL?) -> Void) {
        #if DEBUG
        // automation cannot click a save panel: it names the folder up front
        if AutomationServer.isEnabled, let folder = ProcessInfo.processInfo.environment["DOCMORE_AUTOMATION_DOWNLOAD_DIR"] {
            let name = (suggestedName.isEmpty ? "download" : suggestedName).replacingOccurrences(of: "/", with: "_")
            completion(URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent(name))
            return
        }
        #endif
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedName.isEmpty ? "download" : suggestedName
        panel.canCreateDirectories = true
        if let window {
            panel.beginSheetModal(for: window) { response in
                completion(response == .OK ? panel.url : nil)
            }
        } else {
            completion(panel.runModal() == .OK ? panel.url : nil)
        }
    }

    /// Saves something served through the app's own scheme: the same request
    /// goes to the server with the sign-in (or to the offline cache) and the
    /// person picks where it lands.
    func saveFromServer(path: String, suggestedName: String?) {
        let fallbackName = path.split(separator: "?").first?.split(separator: "/").last
            .map { String($0).removingPercentEncoding ?? String($0) } ?? "download"
        let session = self.session
        chooseDestination(suggestedName: suggestedName ?? fallbackName) { [weak self] destination in
            guard let destination else { return }
            Task { @MainActor in
                do {
                    let data: Data
                    do {
                        let (body, response) = try await session.api.send("GET", path, timeout: 600)
                        guard (200..<300).contains(response.statusCode) else {
                            throw ServerAPI.APIError.status(response.statusCode, "")
                        }
                        data = body
                    } catch let error as URLError {
                        // server out of reach: the offline copy, when there is one
                        guard let key = FileCacheKey.key(for: path), let cached = session.files.fileURL(key) else { throw error }
                        data = try Data(contentsOf: cached)
                    }
                    try data.write(to: destination, options: .atomic)
                } catch {
                    self?.presentError(L("The download failed"), detail: error.localizedDescription)
                }
            }
        }
    }

    func presentError(_ title: String, detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: L("OK"))
        if let window {
            alert.beginSheetModal(for: window, completionHandler: nil)
        } else {
            alert.runModal()
        }
    }
}
