#!/usr/bin/env python3
"""Sinh "generated interface" của 1 Swift module bằng sourcekitd.

Đây là đúng thứ Xcode hiển thị khi Cmd-click vào 1 API (breadcrumb
"Simulator - iOS 26.2 > SwiftUI"): declaration + FULL doc comment `///`.
File .swiftinterface trong SDK đã bị strip hết doc, nên không dùng được.

Usage: gen-iface.py <Module> <target-triple> <sdk-path> <out-path>
In ra stdout: "<số dòng> <out-path>". Exit != 0 nếu thất bại.
"""
import ctypes
import os
import sys
import tempfile

SOURCEKITD = (
    '/Applications/Xcode.app/Contents/Developer/Toolchains/'
    'XcodeDefault.xctoolchain/usr/lib/sourcekitd.framework/sourcekitd'
)


class Variant(ctypes.Structure):
    # sourcekitd_variant_t = { uint64_t data[3]; }
    _fields_ = [('data', ctypes.c_uint64 * 3)]


def load():
    lib = ctypes.CDLL(SOURCEKITD)
    lib.sourcekitd_initialize()
    lib.sourcekitd_request_create_from_yaml.restype = ctypes.c_void_p
    lib.sourcekitd_request_create_from_yaml.argtypes = [
        ctypes.c_char_p, ctypes.POINTER(ctypes.c_char_p)]
    lib.sourcekitd_send_request_sync.restype = ctypes.c_void_p
    lib.sourcekitd_send_request_sync.argtypes = [ctypes.c_void_p]
    lib.sourcekitd_response_is_error.restype = ctypes.c_bool
    lib.sourcekitd_response_is_error.argtypes = [ctypes.c_void_p]
    lib.sourcekitd_response_error_get_description.restype = ctypes.c_char_p
    lib.sourcekitd_response_error_get_description.argtypes = [ctypes.c_void_p]
    lib.sourcekitd_response_get_value.restype = Variant
    lib.sourcekitd_response_get_value.argtypes = [ctypes.c_void_p]
    lib.sourcekitd_uid_get_from_cstr.restype = ctypes.c_void_p
    lib.sourcekitd_uid_get_from_cstr.argtypes = [ctypes.c_char_p]
    # Lấy chuỗi qua variant API: response_description_copy trả dạng YAML đã
    # escape, parse ngược rất dễ sai ở doc comment chứa \n / dấu ngoặc kép.
    lib.sourcekitd_variant_dictionary_get_string.restype = ctypes.c_char_p
    lib.sourcekitd_variant_dictionary_get_string.argtypes = [Variant, ctypes.c_void_p]
    return lib


def main():
    if len(sys.argv) != 5:
        sys.exit(__doc__)
    module, target, sdk, out = sys.argv[1:5]
    lib = load()
    yaml = (
        '{ key.request: source.request.editor.open.interface,'
        ' key.name: "ios-sdk-mcp-%s",'
        ' key.modulename: "%s",'
        ' key.compilerargs: ["-target","%s","-sdk","%s"] }'
        % (module, module, target, sdk)
    ).encode()
    err = ctypes.c_char_p()
    req = lib.sourcekitd_request_create_from_yaml(yaml, ctypes.byref(err))
    if not req:
        sys.exit('bad request: %s' % (err.value,))
    resp = lib.sourcekitd_send_request_sync(req)
    if not resp:
        sys.exit('no response')
    if lib.sourcekitd_response_is_error(resp):
        sys.exit('sourcekitd error: %s' %
                 (lib.sourcekitd_response_error_get_description(resp),))
    val = lib.sourcekitd_response_get_value(resp)
    uid = lib.sourcekitd_uid_get_from_cstr(b'key.sourcetext')
    src = lib.sourcekitd_variant_dictionary_get_string(val, uid)
    if not src:
        sys.exit('no key.sourcetext for module %s' % module)
    text = src.decode('utf-8', 'replace')

    # Ghi atomic: MCP có thể chạy nhiều request song song, đọc file dở dang
    # sẽ cho ra decl cụt.
    os.makedirs(os.path.dirname(out), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(out), suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as fh:
            fh.write(text)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    print('%d %s' % (text.count('\n') + 1, out))


if __name__ == '__main__':
    main()
