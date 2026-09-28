# Copyright 2026 Codemarchant
"""perform_song: the companion performs a song on the karaoke stage.

Voice calls only. It offers the songs this companion has already learned
(their vocals rendered in its current singing voice, see singing.py); the
browser plays the backing and the vocal and makes the avatar dance
(web/src/models/stage.js), so nothing is rendered during the call.

Named "perform", not "sing": as sing_song, a casual "can you sing me a
song?" went straight to a minutes-long stage show of a random song, where a
few lines of <singing> in the reply were what was wanted. The description
says so too, and has the companion offer a choice when no song was named.
"""

PERFORM_SONG_TOOL_NAME = 'perform_song'


def build_perform_tool(con, agent):
    """perform_song for a voice call: perform a song this companion has
    learned (its vocals rendered in its voice) on the karaoke stage. None
    when it knows none. The browser runs it (web/src/models/stage.js)."""
    from .routes.songs import singer_for
    _voice, _profile, singer = singer_for(con, agent['id'])
    rows = con.execute(
        """SELECT s.title, s.duration_seconds FROM songs s
           JOIN song_vocals v ON v.song_id = s.id AND v.voice = ?
           ORDER BY lower(s.title)""", (singer,)).fetchall()
    if not rows:
        return None
    titles = []
    for r in rows:
        if r['title'] not in titles:
            titles.append(r['title'])
    listing = '; '.join(f'"{r["title"]}" ({int(r["duration_seconds"] or 0) // 60}:{int(r["duration_seconds"] or 0) % 60:02d})'
                        for r in rows)
    return {
        'name': PERFORM_SONG_TOOL_NAME,
        'description': (
            'Perform a full song on the karaoke stage: the backing track plays for a few minutes '
            'while you sing it in your own voice and dance, with the lyrics rolling on screen. '
            'It\'s a show, not a quick tune. When the user just wants you to sing something, or '
            'a line or two fits the moment, sing it yourself in your reply with '
            '<singing>…</singing>, a little tune of your own. Take the stage when they ask for '
            'one of the songs below by name, or want a proper performance; if they haven\'t said '
            'which song, suggest two or three that suit the moment and let them pick. '
            f'Songs you know: {listing}. '
            'The call answers at once; say a short line first (the song starts right after), and '
            'don\'t talk over it: the user\'s mic is muted while it plays and you get a note when '
            'it ends. mode: "i_sing" (you sing, the default), "duet" (you take turns with the '
            'user, who sings every other line or the second part), or "user_sings" (karaoke for '
            'them: you dance, their singing is scored).'
        ),
        'parameters': {
            'type': 'object',
            'properties': {
                'song': {'type': 'string', 'enum': titles, 'description': 'The song to perform.'},
                'mode': {'type': 'string', 'enum': ['i_sing', 'duet', 'user_sings']},
            },
            'required': ['song'],
        },
    }
