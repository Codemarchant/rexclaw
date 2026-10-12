# Copyright 2026 Codemarchant
"""Audio from a link: YouTube, any other site yt-dlp supports, or a direct
link to an audio file. Shared by whatever pulls audio from the web
(create_voicemail's `sounds`).

yt-dlp downloads with its own downloader, no ffmpeg needed. YouTube's
signature checks run its solver scripts (yt-dlp-ejs) on Deno, from the
`deno` wheel. PyAV (FFmpeg's libraries) decodes whatever comes down
(webm/opus, m4a, mp3, a video's soundtrack) to a WAV soundfile reads.
"""
import re
from pathlib import Path
from urllib.parse import unquote, urlparse

import requests

from .errors import UserError

MAX_DOWNLOAD_BYTES = 1024 ** 3   # a ten-hour ambience video is ~600 MB of opus
# Links to these download as plain files with an honest user agent: yt-dlp
# sends a browser's, which some hosts refuse (Wikimedia: 403).
FILE_EXTS = ('.mp3', '.ogg', '.oga', '.opus', '.wav', '.flac', '.m4a', '.aac')
USER_AGENT = 'Rexclaw (https://github.com/codemarchant/rexclaw)'


def fetch_audio(url, out_dir, max_seconds=None):
    """Download `url` into `out_dir` → {'audio': WAV path, 'title',
    'artist', 'duration', 'webpage_url', 'raw_title'} (the Voice Lab
    fetch job's shape). `max_seconds` keeps only the start: the whole file
    is downloaded and cut while decoding, because a ranged download goes
    through ffmpeg, which YouTube throttles (measured 156 s for 5 min of
    audio, against 9 s for a whole hour with yt-dlp's own downloader)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = unquote(urlparse(url).path)
    if path.lower().endswith(FILE_EXTS):
        src = _download_file(url, out_dir / ('source' + Path(path).suffix.lower()))
        info = {'title': Path(path).stem}
    else:
        src, info = _download_ytdlp(url, out_dir)
    wav = out_dir / 'audio.wav'
    to_wav(src, wav, max_seconds)
    return {'audio': str(wav),
            'title': info.get('track') or info.get('title') or '',
            'artist': info.get('artist') or info.get('creator') or info.get('uploader') or '',
            'duration': info.get('duration'), 'webpage_url': info.get('webpage_url') or url,
            'raw_title': info.get('title') or ''}


def _download_ytdlp(url, out_dir):
    """→ (downloaded file, yt-dlp info). Live streams are skipped (they
    never end), and a playlist link gives its first item."""
    import deno
    import yt_dlp
    opts = {'quiet': True, 'no_warnings': True, 'noprogress': True, 'noplaylist': True,
            'playlist_items': '1', 'format': 'bestaudio/best', 'max_filesize': MAX_DOWNLOAD_BYTES,
            'match_filter': yt_dlp.utils.match_filter_func('!is_live'),
            'outtmpl': str(out_dir / 'source.%(ext)s'),
            'js_runtimes': {'deno': {'path': deno.find_deno_bin()}}}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True) or {}
    except yt_dlp.utils.DownloadError as e:
        reason = re.sub(r'^ERROR:\s*', '', str(e))
        raise UserError(f'Could not download {url}: {reason}')
    if info.get('entries') is not None:
        info = next((e for e in info['entries'] if e), {})
    done = [d.get('filepath') for d in info.get('requested_downloads') or ()]
    src = next((Path(p) for p in done if p and Path(p).is_file()), None)
    if src is None:
        raise UserError(f'Nothing was downloaded from {url}: it is a live stream, has no audio, or '
                        f'is over {MAX_DOWNLOAD_BYTES // 1024 ** 3} GB.')
    return src, info


def _download_file(url, dst):
    try:
        with requests.get(url, stream=True, timeout=30, headers={'User-Agent': USER_AGENT}) as r:
            r.raise_for_status()
            if r.headers.get('content-type', '').startswith('text/'):
                raise UserError(f'{url} is a web page, not an audio file.')
            size = 0
            with open(dst, 'wb') as f:
                for chunk in r.iter_content(1 << 16):
                    size += len(chunk)
                    if size > MAX_DOWNLOAD_BYTES:
                        raise UserError(f'{url} is over {MAX_DOWNLOAD_BYTES // 1024 ** 3} GB.')
                    f.write(chunk)
    except requests.RequestException as e:
        raise UserError(f'Could not download {url}: {e}')
    return dst


def to_wav(src, dst, max_seconds=None):
    """Decode any audio or video file → a stereo 16-bit WAV at its own
    sample rate, at most `max_seconds` long. Streams frame by frame, so an
    hour of audio never sits in memory."""
    import av
    import soundfile as sf
    try:
        with av.open(str(src)) as container:
            if not container.streams.audio:
                raise UserError('The download has no audio.')
            stream = container.streams.audio[0]
            rate = stream.codec_context.sample_rate
            resampler = av.AudioResampler(format='flt', layout='stereo', rate=rate)
            limit = int(max_seconds * rate) if max_seconds else None
            written = 0
            with sf.SoundFile(dst, 'w', rate, 2, subtype='PCM_16') as out:
                for frame in _resampled(container, stream, resampler):
                    x = frame.to_ndarray().reshape(-1, 2)   # packed float: L R L R …
                    if limit is not None:
                        x = x[:limit - written]
                    out.write(x)
                    written += len(x)
                    if limit is not None and written >= limit:
                        break
    except av.error.FFmpegError as e:
        raise UserError(f'Could not decode the download: {e}')
    if not written:
        raise UserError('The download holds no audio.')
    return written / rate


def _resampled(container, stream, resampler):
    for frame in container.decode(stream):
        yield from resampler.resample(frame)
    yield from resampler.resample(None)   # flush
