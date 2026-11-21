import Foundation
import WebKit

/// Answers everything the page asks of `docmore-app://<profile>/`:
/// the web client from disk, `/api` through the proxy, files from the server
/// or from the offline cache.
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let context: ProxyContext
    private var boxes: [ObjectIdentifier: SchemeTaskBox] = [:]
    /// The bundle each web view opened its page with, so lazy chunks keep
    /// coming from the same copy after a new bundle became current.
    private let pinned = NSMapTable<WKWebView, NSString>.weakToStrongObjects()
    private let io = DispatchQueue(label: "com.dezik.docmore.static", qos: .userInitiated, attributes: .concurrent)

    init(context: ProxyContext) {
        self.context = context
    }

    /// Bundles in use by open pages (not to be pruned).
    var pinnedHashes: Set<String> {
        var result = Set<String>()
        let enumerator = pinned.objectEnumerator()
        while let value = enumerator?.nextObject() as? NSString {
            result.insert(value as String)
        }
        return result
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        if boxes.count > 64 {
            boxes = boxes.filter { !$0.value.isDone }
        }
        let box = SchemeTaskBox(urlSchemeTask)
        boxes[ObjectIdentifier(urlSchemeTask)] = box
        let request = urlSchemeTask.request
        guard let url = request.url else {
            box.finish { $0.didFailWithError(URLError(.badURL)) }
            return
        }
        let method = request.httpMethod ?? "GET"
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path

        switch RequestRouter.route(method: method, path: path) {
        case .api:
            let exchange = ProxyExchange(context: context, box: box, cacheKey: nil)
            box.onStop { exchange.cancel() }
            exchange.start()
        case .cachedFile(let key):
            let exchange = ProxyExchange(context: context, box: box, cacheKey: key)
            box.onStop { exchange.cancel() }
            exchange.start()
        case .staticFile(let relative):
            let isMainDocument = request.mainDocumentURL == nil || request.mainDocumentURL == url
            if isMainDocument, let hash = context.bundle.current?.hash {
                pinned.setObject(hash as NSString, forKey: webView)
            }
            let pinnedHash = pinned.object(forKey: webView) as String?
            serveStatic(relative, url: url, box: box, pinnedHash: pinnedHash)
        case .invalid:
            respond(box, url: url, status: 400, type: "text/plain; charset=utf-8", data: Data("Bad request".utf8), cache: "no-store")
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        boxes[id]?.stop()
        boxes.removeValue(forKey: id)
    }

    private func serveStatic(_ relative: String, url: URL, box: SchemeTaskBox, pinnedHash: String?) {
        let bundle = context.bundle
        io.async { [weak self] in
            var path = relative
            var file = bundle.fileURL(path: path, pinnedHash: pinnedHash)
            if file == nil, RequestRouter.servesIndexFallback(path: path, fileExists: false) {
                path = "index.html"
                file = bundle.fileURL(path: path, pinnedHash: pinnedHash)
            }
            let data = file.flatMap { try? Data(contentsOf: $0, options: .mappedIfSafe) }
            DispatchQueue.main.async {
                guard let self else { return }
                guard let data else {
                    let missingClient = bundle.current == nil
                    self.respond(
                        box,
                        url: url,
                        status: missingClient ? 503 : 404,
                        type: "text/plain; charset=utf-8",
                        data: Data((missingClient ? "The web client is not downloaded yet" : "Not found").utf8),
                        cache: "no-store"
                    )
                    return
                }
                // hashed assets never change; everything else is re-read
                let cache = path.hasPrefix("assets/") ? "public, max-age=31536000, immutable" : "no-cache"
                self.respond(box, url: url, status: 200, type: ContentTypes.type(forPath: path), data: data, cache: cache)
            }
        }
    }

    private func respond(_ box: SchemeTaskBox, url: URL, status: Int, type: String, data: Data, cache: String) {
        let headers = [
            "Content-Type": type,
            "Content-Length": "\(data.count)",
            "Cache-Control": cache,
            "Access-Control-Allow-Origin": "*",
        ]
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        box.respond { $0.didReceive(response) }
        box.respond { $0.didReceive(data) }
        box.finish { $0.didFinish() }
    }
}
