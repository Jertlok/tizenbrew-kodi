#!/usr/bin/env python3
# Where the CPU went in a kodi-run.mjs --cpuprof capture: per thread and by category.
#
#   tools/cpuprof.py <capture.json> <kodi.wasm with names> [--threads]
#
# The wasm needs a name section: relink the same build with --profiling-funcs (a FAST_LINK
# relink keeps the function indices; compare the code sections). A thread's role is the start
# routine of its pthread (recorded by kodi-run at the start and end of the capture). A sample
# counts as run time unless the thread is idle or blocked in a wait; its category is the first
# rule below that matches any frame of its stack.
import collections, json, re, sys

def wasm_names(path):
    """Function names by function index, and the function index of each table slot."""
    f = open(path, 'rb').read()
    def leb(i):
        r = s = 0
        while True:
            b = f[i]; i += 1; r |= (b & 0x7f) << s; s += 7
            if b < 0x80: return r, i
    names, table, i = {}, {}, 8
    while i < len(f):
        sid = f[i]; n, i = leb(i + 1); end = i + n
        if sid == 9:  # active element segments of table 0 (flags 0), as wasm-ld writes them
            c, j = leb(i)
            for _ in range(c):
                flags, j = leb(j); assert flags == 0 and f[j] == 0x41, 'unexpected element segment'
                off, j = leb(j + 1); cnt, j = leb(j + 1)
                for k in range(cnt): table[off + k], j = leb(j)
        elif sid == 0:
            l, j = leb(i)
            if f[j:j + l] == b'name':
                j += l
                while j < end:
                    sub = f[j]; sl, j = leb(j + 1); se = j + sl
                    if sub == 1:
                        c, j = leb(j)
                        for _ in range(c):
                            fi, j = leb(j); l, j = leb(j); names[fi] = f[j:j + l].decode('utf8', 'replace'); j += l
                    j = se
        i = end
    return names, table

WAIT = re.compile(r'futex_wait|__timedwait|pthread_cond_(timed)?wait|emscripten_thread_sleep|nanosleep|__wait\b|_emscripten_yield|sem_wait|pthread_mutex_lock|pthread_join')
CATS = [(n, re.compile(p)) for n, p in [
    ('TV player: appendPacketSync', r'appendPacketSync|_tizen_emss_append'),
    ('Tizen sync IPC: systeminfo memory', r'getAvailableMemory|getTotalMemory|sendSyncMessageWithStringReply'),
    ('mallinfo', r'dlmallinfo'),
    ('TLS / crypto (OpenSSL)', r'^(SSL_|ssl3_|ssl_|tls_|tls1_|EVP_|BN_|bn_|sha1_|sha256|sha512|SHA|aes|AES_|gcm_|CRYPTO_|ec_|EC_|x25519|X25519|ossl_|RSA_|rsa_|X509|x509|ASN1|asn1|ChaCha|chacha|Poly1305|poly1305|OPENSSL|PEM_|ecp_nistz|curve25519)'),
    ('Worker start-up', r'receiveInstance|establishStackSpace|sharedRegisterType|loadWasmModuleToWorker|__wasm_init|initRuntime'),
    ('new Worker (main thread)', r'^Worker$|allocateUnusedWorker|getNewWorker'),
    ('GL / WebGL', r'^_?gl[A-Z]|^emscripten_gl|webgl|GLctx|CRenderSystemGLES'),
    ('Kodi GUI', r'CGUI[A-Z]|CGraphicContext|CApplication::(Render|FrameMove)|CRenderSystem|CTexture|hb_|OT::'),
    ('Python interpreter', r'^_?Py|^builtin_|^(list|dict|long|unicode|float|type|object|frame|gen|func|method|tuple|bytes|set)_|^_?sre|vgetargs|SWIG'),
    ('proxied calls on the main thread', r'receive_notification|checkMailbox|_emscripten_receive_on_main_thread_js|__syscall_|^fd_'),
    ('sockets', r'tizen_socket|SocketsManager|pollMixed'),
    ('curl', r'^Curl_|^curl_|XCURL'),
    ('sqlite', r'^sqlite3'),
    ('VideoPlayer, cache, demux', r'CVideoPlayer|CDVD|CFileCache|CCircularCache|^avio_|^av_|^ff_|^mov_|CMediaPipeline|CBitstream'),
    ('logging', r'CLog|spdlog|^fmt::'),
    ('malloc', r'malloc|dlfree|emscripten_builtin_free|operator new|operator delete'),
    ('JS garbage collector', r'^\(garbage collector\)$'),
    ('time queries', r'_emscripten_get_now|clock_time_get|^now$|date_now|checkWasiClock|clock_gettime'),
    ('rAF vsync tick (page)', r'^tick$'),
]]

def main():
    cap = json.load(open(sys.argv[1])); names, table = wasm_names(sys.argv[2]); threads = '--threads' in sys.argv
    meta = cap['meta']
    def role(p):
        if p['session'] == 'page': return 'main thread (page)'
        m = re.match(r'em-pthread-(\d+)', p.get('title') or '')
        for k in ('rolesAtStart', 'rolesAtEnd'):
            sr = m and meta.get(k, {}).get(m.group(1))
            if sr is not None:
                n = names.get(table.get(int(sr)), str(sr))
                for label, pat in [('Python thread', 'pythread_wrapper'), ("Kodi's app thread", '^_main_thread$'), ('curl resolver', 'curl_thread_create_thunk')]:
                    if re.search(pat, n): return label
                # std::thread lambdas: CThread::Create(bool)::$_0 is any Kodi thread.
                m2 = re.search(r'([A-Za-z_][\w:]*)\(\w*\)::\$_\d+', n)
                if not m2: return n[:60]
                return 'Kodi CThread' if m2.group(1) == 'CThread::Create' else 'thread of ' + m2.group(1)
        return 'Worker without a pthread'
    def fname(cf):
        m = re.match(r'wasm-function\[(\d+)\]', cf['functionName'])
        return names.get(int(m.group(1)), cf['functionName']) if m else cf['functionName'] or '(anonymous)'
    cats, roles, window = collections.Counter(), collections.Counter(), 0
    for p in cap['profiles']:
        prof = p.get('profile')
        if not prof: continue
        nodes = {n['id']: n for n in prof['nodes']}; parent = {c: n['id'] for n in prof['nodes'] for c in n.get('children', [])}
        memo = {}
        def stack(i):
            if i not in memo:
                s, j = [], i
                while j is not None: s.append(fname(nodes[j]['callFrame'])); j = parent.get(j)
                memo[i] = s
            return memo[i]
        dt, total, ran, mine, selfs = prof['timeDeltas'], 0, 0, collections.Counter(), collections.Counter()
        for k, sid in enumerate(prof['samples']):
            t = dt[k + 1] if k + 1 < len(dt) else 0; total += t; s = stack(sid)
            if s[0] in ('(idle)', '(program)') or any(WAIT.search(f) for f in s[:6]): continue
            ran += t; selfs[s[0]] += t
            mine[next((n for n, r in CATS if any(r.search(f) for f in s)), 'other: ' + s[0][:50])] += t
        if p['session'] == 'page': window = total
        r = role(p); roles[r] += ran; cats.update(mine)
        if threads and ran > 0.2e6:
            print(f"{p.get('title')}: {r}, ran {ran / 1e6:.2f} s ({100 * ran / max(total, 1):.0f}% of a core)")
            for f, t in selfs.most_common(6): print(f'    {100 * t / ran:5.1f}%  {f[:100]}')
    allran = sum(cats.values())
    print(f"window {window / 1e6:.1f} s: {allran / 1e6:.2f} s of CPU over the profiled threads = {allran / max(window, 1):.2f} cores; "
          f"rAF {meta.get('rafFps')} fps; {sum(1 for p in cap['profiles'] if p.get('profile'))} of {len(cap['profiles'])} threads profiled")
    for title, c in (('by thread', roles), ('by category', cats)):
        print('--', title)
        for k, v in c.most_common(16): print(f'  {100 * v / allran:5.1f}%  {v / 1e6:5.2f} s  {k}')

if __name__ == '__main__':
    main()
