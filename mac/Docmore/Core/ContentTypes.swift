import Foundation

/// `Content-Type` for the files of the web client, by extension.
public enum ContentTypes {
    private static let table: [String: String] = [
        "html": "text/html; charset=utf-8",
        "htm": "text/html; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "map": "application/json; charset=utf-8",
        "webmanifest": "application/manifest+json; charset=utf-8",
        "txt": "text/plain; charset=utf-8",
        "xml": "application/xml; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "avif": "image/avif",
        "ico": "image/x-icon",
        "bmp": "image/bmp",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "otf": "font/otf",
        "eot": "application/vnd.ms-fontobject",
        "wasm": "application/wasm",
        "pdf": "application/pdf",
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "ogg": "audio/ogg",
        "m4a": "audio/mp4",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "mov": "video/quicktime",
        "zip": "application/zip",
        "csv": "text/csv; charset=utf-8",
        "md": "text/markdown; charset=utf-8",
    ]

    public static let fallback = "application/octet-stream"

    public static func type(forExtension ext: String) -> String {
        table[ext.lowercased()] ?? fallback
    }

    public static func type(forPath path: String) -> String {
        type(forExtension: fileExtension(of: path))
    }

    /// Extension of the last path component, without the dot ("" when none).
    public static func fileExtension(of path: String) -> String {
        let last = path.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? ""
        guard let dot = last.lastIndex(of: "."), dot != last.startIndex else { return "" }
        return String(last[last.index(after: dot)...])
    }
}
