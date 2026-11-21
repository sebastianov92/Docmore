import Foundation

/// JavaScript injected at document start, before any script of the page.
enum PageScripts {
    /// WebKit hands a custom scheme handler the body of a request only when
    /// it is plain bytes or text. A `Blob`, a `File` or a `FormData` holding a
    /// file never arrives: `httpBody` and `httpBodyStream` are both nil
    /// (measured on macOS 27 / WebKit 624: uploads reached the proxy empty).
    ///
    /// This shim turns such bodies into an `ArrayBuffer` first, which WebKit
    /// does deliver, keeping the multipart boundary in `Content-Type`. It
    /// only touches requests to the page's own origin and leaves every other
    /// kind of body alone.
    static let bodyShim = """
    (function () {
      if (window.__docmoreBodyShim) return;
      window.__docmoreBodyShim = true;
      var sameOrigin = function (url) {
        try { return new URL(url, window.location.href).origin === window.location.origin; } catch (e) { return false; }
      };
      var isBinary = function (body) {
        return (typeof Blob !== "undefined" && body instanceof Blob) ||
          (typeof FormData !== "undefined" && body instanceof FormData) ||
          (typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
      };

      var nativeFetch = window.fetch;
      if (nativeFetch) {
        window.fetch = function (input, init) {
          var self = this;
          try {
            var isRequest = typeof Request !== "undefined" && input instanceof Request;
            var url = isRequest ? input.url : String(input);
            if (sameOrigin(url)) {
              var body = init && init.body != null ? init.body : null;
              if (body != null && isBinary(body)) {
                var carrier = new Response(body);
                var type = carrier.headers.get("content-type");
                return carrier.arrayBuffer().then(function (buffer) {
                  var headers = new Headers((init && init.headers) || (isRequest ? input.headers : undefined));
                  if (type && !headers.has("content-type")) headers.set("content-type", type);
                  var next = {};
                  for (var key in init) next[key] = init[key];
                  next.body = buffer;
                  next.headers = headers;
                  delete next.duplex;
                  return nativeFetch.call(self, input, next);
                });
              }
              if (body == null && isRequest && !/^(GET|HEAD)$/i.test(input.method)) {
                // a Request that carries its own body, possibly a Blob underneath
                return input.clone().arrayBuffer().then(function (buffer) {
                  if (!buffer || buffer.byteLength === 0) return nativeFetch.call(self, input, init);
                  return nativeFetch.call(self, new Request(input, { body: buffer }), init);
                }, function () {
                  return nativeFetch.call(self, input, init);
                });
              }
            }
          } catch (e) {}
          return nativeFetch.apply(this, arguments);
        };
      }

      var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (proto) {
        var nativeOpen = proto.open, nativeSend = proto.send, nativeSetHeader = proto.setRequestHeader;
        var meta = new WeakMap();
        proto.open = function (method, url) {
          meta.set(this, { url: String(url), hasType: false });
          return nativeOpen.apply(this, arguments);
        };
        proto.setRequestHeader = function (name) {
          var entry = meta.get(this);
          if (entry && String(name).toLowerCase() === "content-type") entry.hasType = true;
          return nativeSetHeader.apply(this, arguments);
        };
        proto.send = function (body) {
          var entry = meta.get(this);
          var binary = body != null && ((typeof Blob !== "undefined" && body instanceof Blob) || (typeof FormData !== "undefined" && body instanceof FormData));
          if (binary && entry && sameOrigin(entry.url)) {
            var xhr = this;
            var carrier = new Response(body);
            var type = carrier.headers.get("content-type");
            carrier.arrayBuffer().then(function (buffer) {
              try {
                if (type && !entry.hasType) nativeSetHeader.call(xhr, "Content-Type", type);
                nativeSend.call(xhr, buffer);
              } catch (e) {}
            }, function () {
              try { nativeSend.call(xhr, body); } catch (e) {}
            });
            return;
          }
          return nativeSend.apply(this, arguments);
        };
      }
    })();
    """
}
