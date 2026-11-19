"""Local-only mirror failover candidate; never executes APT or edits host files.
Supported shape must be observed on the real runner before integration. The
synthetic sequence models download-only attempts followed by exactly one install.
"""
import re
from urllib.parse import urlsplit

FIRST = 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/'
NEXT = {'https://archive.ubuntu.com/ubuntu/', 'https://security.ubuntu.com/ubuntu/'}
ARCHIVE_SUITES = {'resolute', 'resolute-updates', 'resolute-backports'}
COMPONENTS = {'main', 'restricted', 'universe', 'multiverse'}
MIRROR_URI = 'mirror+file:/etc/apt/apt-mirrors.txt'


def parse_mirrors(text):
    if len(text.encode()) > 4096:
        raise ValueError('mirrorlist-bound')
    entries = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        tokens = line.split()
        if len(tokens) != 2 or tokens[1] != 'priority:' + str(len(entries) + 1):
            raise ValueError('unsupported-ranked-mirror-metadata')
        entries.append(tokens[0])
    if entries != [FIRST, 'https://archive.ubuntu.com/ubuntu/', 'https://security.ubuntu.com/ubuntu/']:
        raise ValueError('not-observed-ec2-pool-with-existing-next-candidate')
    return entries


def source_fields(block):
    fields = {}
    for line in block.splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z-]+):[ \t]+([^\n]+)', line)
        if not match or match[1] in fields:
            raise ValueError('unsupported-deb822-or-folding')
        fields[match[1]] = match[2].strip()
    if fields.get('Trusted', '').lower() in ('yes', 'true', '1'):
        raise ValueError('weakened-source-trust')
    for key in ('Check-Date', 'Check-Valid-Until'):
        if fields.get(key, 'yes').lower() not in ('yes', 'true', '1'):
            raise ValueError('weakened-source-validity')
    if any(key.startswith(('Allow-', 'Valid-Until-')) for key in fields):
        raise ValueError('unsupported-source-security-override')
    return fields


def fallback_plan(sources, mirrors, failed_uri, native_exit, remaining_ms, nonce, failure_kind):
    if len(sources.encode()) > 16384 or not re.fullmatch('[a-f0-9]{32}', nonce):
        raise ValueError('scope-bound')
    failed = urlsplit(failed_uri)
    if (failed.scheme != 'http' or failed.hostname != 'us-east-2.ec2.archive.ubuntu.com'
            or failed.port is not None or failed.username or failed.password or failed.query or failed.fragment
            or not failed.path.startswith('/ubuntu/pool/') or '..' in failed.path.split('/')):
        raise ValueError('not-the-observed-ec2-package-pool')
    if failure_kind not in ('transport-error', 'inactivity-timeout'):
        raise ValueError('not-a-confirmed-transport-failure')
    if native_exit not in (100, 124) or type(native_exit) is not int:
        raise ValueError('not-a-download-acquisition-failure')
    if type(remaining_ms) is not int or remaining_ms <= 5000 or remaining_ms > 595000:
        raise ValueError('no-original-budget-for-retry')
    entries = parse_mirrors(mirrors)
    blocks = re.split(r'(\n[ \t]*\n)', sources)
    replaced = 0
    security = 0
    private = '/tmp/outliner-apt-' + nonce
    for i in range(0, len(blocks), 2):
        fields = source_fields(blocks[i])
        if not fields:
            continue
        if fields.get('Types') != 'deb' or fields.get('Signed-By') != '/usr/share/keyrings/ubuntu-archive-keyring.gpg':
            raise ValueError('unsupported-ubuntu-source-contract')
        if set(fields.get('Components', '').split()) != COMPONENTS:
            raise ValueError('incomplete-component-set')
        suites = set(fields.get('Suites', '').split())
        if suites == ARCHIVE_SUITES and fields.get('URIs') == MIRROR_URI:
            blocks[i], count = re.subn(r'(?m)^URIs:[ \t]+' + re.escape(MIRROR_URI) + r'[ \t]*$',
                                      'URIs: mirror+file:' + private + '/mirrors.txt', blocks[i])
            if count != 1:
                raise ValueError('ambiguous-source-uri')
            replaced += 1
        elif suites == {'resolute-security'} and fields.get('URIs') in ('http://security.ubuntu.com/ubuntu/', 'https://security.ubuntu.com/ubuntu/'):
            security += 1  # Entire original security paragraph remains byte-identical.
        else:
            raise ValueError('unsupported-suite-source-layout')
    if replaced != 1 or security != 1:
        raise ValueError('incomplete-source-layout')
    return {'ubuntu_sources': ''.join(blocks), 'private_mirrorlist': entries[1] + '\tpriority:2\n',
            'private_directory': private, 'max_retry_count': 1, 'remaining_original_ms': remaining_ms,
            'signed_by_unchanged': True, 'dpkg_during_acquisition': False,
            'host_files_changed': False, 'ready_for_real_runner': False}


def sequence(download, install, make_retry, remaining):
    """Explicit offline adapters only. Real integration must additionally prove
    transport-failure classification and effective APT trust/resolver settings.
    No fresh budget is granted; callers own the original absolute deadline.
    """
    code = download(None, remaining())
    if code:
        retry = make_retry(code, remaining())  # raises on unsupported/no budget
        code = download(retry, remaining())
    if code:
        return code
    budget = remaining()
    if budget <= 0:
        return 124
    return install(no_download=True, remaining_ms=budget)  # Never retry or interrupt dpkg here.
