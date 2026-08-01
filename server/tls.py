# Copyright 2026 Codemarchant
"""Optional HTTPS for the standalone server.

WebXR and getUserMedia only exist on secure origins, so reaching the app
from a headset browser over LAN (https://<pc-ip>:8990) needs TLS — plain
HTTP silently hides the Enter VR button and the microphone. Two ways in:

  REXCLAW_SSL_CERT / REXCLAW_SSL_KEY   use your own certificate pair
  REXCLAW_SSL=1                        generate (once) a self-signed pair
                                       under <data dir>/certs/

Self-signed means the headset browser shows a one-time "connection not
private" warning; after proceeding, Chromium-based browsers treat the
origin as secure and expose WebXR/mic. Unset → the server stays plain
HTTP, byte-for-byte the previous behaviour.
"""
import ipaddress
import logging
import os
import socket

from .db import DATA_DIR

_logger = logging.getLogger(__name__)

CERT_DAYS = 3650


def resolve_ssl():
    """Return uvicorn ssl kwargs ({"ssl_certfile": …, "ssl_keyfile": …})
    when HTTPS is requested via the environment, else {}."""
    cert = os.environ.get("REXCLAW_SSL_CERT")
    key = os.environ.get("REXCLAW_SSL_KEY")
    if cert and key:
        return {"ssl_certfile": cert, "ssl_keyfile": key}
    if os.environ.get("REXCLAW_SSL", "").strip().lower() in ("1", "true", "yes"):
        cert_path, key_path = _ensure_self_signed(DATA_DIR / "certs")
        return {"ssl_certfile": str(cert_path), "ssl_keyfile": str(key_path)}
    return {}


def _local_addresses():
    """Best-effort SAN list: localhost, the hostname, and the LAN IP the
    default route uses (the address a headset would dial)."""
    dns = {"localhost", socket.gethostname()}
    ips = {"127.0.0.1"}
    try:
        # No packets are sent — connect() on UDP just resolves the source
        # address the OS would route through.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(dns), sorted(ips)


def _ensure_self_signed(cert_dir):
    """Create (or reuse) a self-signed certificate pair in cert_dir."""
    cert_path = cert_dir / "rexclaw.crt"
    key_path = cert_dir / "rexclaw.key"
    if cert_path.is_file() and key_path.is_file():
        return cert_path, key_path

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        raise RuntimeError(
            "REXCLAW_SSL=1 needs the 'cryptography' package — re-run "
            "run.sh / run.bat once (or pip install cryptography), or point "
            "REXCLAW_SSL_CERT / REXCLAW_SSL_KEY at an existing pair."
        )
    import datetime

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "rexclaw")])
    dns_names, ip_addrs = _local_addresses()
    san = x509.SubjectAlternativeName(
        [x509.DNSName(d) for d in dns_names]
        + [x509.IPAddress(ipaddress.ip_address(i)) for i in ip_addrs]
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=CERT_DAYS))
        .add_extension(san, critical=False)
        .sign(key, hashes.SHA256())
    )

    cert_dir.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    _logger.info("generated self-signed certificate: %s (SANs: %s %s)",
                 cert_path, dns_names, ip_addrs)
    return cert_path, key_path
