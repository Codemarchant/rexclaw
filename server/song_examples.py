# Copyright 2026 Codemarchant
"""Built-in songs for the karaoke stage: originals written for Rexclaw
(shipped under the app's own licence) and public-domain classics (melody
and words out of copyright: Happy Birthday to You has been public domain
in the US since Marya v. Warner/Chappell, 2015, and in the EU since 2017;
the rest are 18th-19th-century or traditional). Each is a song sheet in
ABC notation (song_sheet.py), arranged and synthesised by song_synth.py
the first time the stage needs it; the companion sings it through
singing.py like any other chart. `language` is the TTS language of the
lyrics.
"""

EXAMPLES = [
    {
        'key': 'little-lights',
        'style': 'pop',
        'abc': """\
X:1
T:Little Lights
C:Rexclaw
M:4/4
L:1/8
Q:1/4=96
K:C
"Am"z8|"F"z4 "G"z4|
"Am"EEE G3ED|"F"C2 A,6|
w:You leave the light on in the hall
"C"EEE G3AG|"G"E2 D6|
w:so I can find my way to you
"Am"EEE c3BA|"F"A2 G6|
w:and ev-ery time you say my name
"C"GGA G3ED|"G"D2 C4 z2|
w:the whole world feels a lit-tle new
"F"c4 c2 BA|"G"B2 A2 G4|
w:Stay, stay a lit-tle long-er,
"Em"GGG B3GE|"Am"E2 A6|
w:the stars can wait an-oth-er night
"F"c4 c2 de|"G"d2 c2 B4|
w:Stay, stay a lit-tle long-er,
"C"cGE G3ED|"C"D2 C6|
w:and I'll be sing-ing you to sleep
"Am"EEE G3ED|"F"C2 A,6|
w:We talk a-bout the small-est things,
"C"EEE G3AG|"G"E2 D6|
w:the cof-fee and the fall-ing rain,
"Am"EEE c3BA|"F"A2 G6|
w:but ev-ery word you give to me
"C"GGA G3ED|"G"D2 C4 z2|
w:I'd hear them all a-gain, a-gain
"F"c4 c2 BA|"G"B2 A2 G4|
w:Stay, stay a lit-tle long-er,
"Em"GGG B3GE|"Am"E2 A6|
w:the stars can wait an-oth-er night
"F"c4 c2 de|"G"d2 c2 B4|
w:Stay, stay a lit-tle long-er,
"C"cGE G3ED|"C"D2 C6|
w:and I'll be sing-ing you to sleep
"F"c8-|"C"c8|
w:Stay
""",
    },
    {
        'key': 'neon-hearts',
        'style': 'synthwave',
        'abc': """\
X:1
T:Neon Hearts
C:Rexclaw
M:4/4
L:1/8
Q:1/4=112
K:Am
"Am"z8|"F"z8|"C"z8|"G"z8|
"Am"A2 A2 c2 e2|"F"d2 c2 A4|
w:Ne-on lights a-cross the rain,
"C"G2 G2 c2 e2|"G"d6 z2|
w:call-ing out your name.
"Am"A2 A2 c2 e2|"F"f2 e2 d4|
w:Drive with me be-yond the dark,
"C"e2 d2 c2 B2|"G"B6 z2|
w:light it like a spark.
"F"a4 g2 f2|"G"g4 e4|
w:Ne-on hearts, we glow,
"Am"e2 e2 g2 a2|"G"g2 f2 e4|
w:burn-ing bright-er than the stars,
"F"a4 g2 f2|"G"g4 e4|
w:ne-on hearts, don't go,
"Am"e2 d2 c2 B2|"E"B6 z2|
w:stay un-til the dawn.
"F"a4 g2 f2|"G"g4 e4|
w:Ne-on hearts, we glow,
"Am"e2 e2 g2 a2|"G"g2 f2 e4|
w:burn-ing bright-er than the stars,
"F"a4 g2 f2|"G"g4 e4|
w:ne-on hearts, don't go,
"Am"e2 d2 c2 B2|"Am"A8|
w:stay un-til the dawn.
""",
    },
    {
        'key': 'rainy-window',
        'style': 'lofi',
        'abc': """\
X:1
T:Rainy Window
C:Rexclaw
M:4/4
L:1/8
Q:1/4=80
K:F
"Fmaj7"z8|"Em7"z8|
"Fmaj7"A2 A2 G2 F2|"Em7"G4 E4|
w:Rain a-gainst the win-dow,
"Dm7"F2 F2 E2 D2|"Cmaj7"E6 z2|
w:soft as a-ny song.
"Fmaj7"A2 A2 c2 A2|"Em7"G4 E4|
w:Cof-fee in your hands now,
"Dm7"F2 E2 D2 C2|"Cmaj7"C6 z2|
w:stay here all day long.
"Bbmaj7"d4 c2 A2|"C"c4 A4|
w:Let it pour to-day,
"Am7"c2 c2 A2 G2|"Dm7"A6 z2|
w:we don't have to go,
"Bbmaj7"d4 c2 A2|"C"c4 G4|
w:blan-kets and a book
"Fmaj7"A2 G2 F2 E2|"Fmaj7"F6 z2|
w:and the rain out-side.
""",
    },
    {
        'key': 'happy-birthday',
        'style': 'acoustic',
        'abc': """\
X:1
T:Happy Birthday to You
C:Traditional (public domain)
M:3/4
L:1/8
Q:1/4=100
K:C
"C"z6|"G"z4 G>G|"C"A2 G2 c2|"G"B4
w:Hap-py birth-day to you,
G>G|"G"A2 G2 d2|"C"c4
w:hap-py birth-day to you,
G>G|"C"g2 e2 c2|"F"B2 A2
w:hap-py birth-day dear dar-ling,
f>f|"C"e2 c2 "G"d2|"C"c6|
w:hap-py birth-day to you!
""",
    },
    {
        'key': 'twinkle',
        'style': 'lofi',
        'abc': """\
X:1
T:Twinkle, Twinkle, Little Star
C:Jane Taylor, 1806 (public domain)
M:4/4
L:1/4
Q:1/4=100
K:C
"C"z4|"C"z4|
"C"C C G G|"F"A A "C"G2|
w:Twin-kle twin-kle lit-tle star,
"F"F F "C"E E|"G"D D "C"C2|
w:how I won-der what you are.
"C"G G "F"F F|"C"E E "G"D2|
w:Up a-bove the world so high,
"C"G G "F"F F|"C"E E "G"D2|
w:like a dia-mond in the sky.
"C"C C G G|"F"A A "C"G2|
w:Twin-kle twin-kle lit-tle star,
"F"F F "C"E E|"G"D D "C"C2|
w:how I won-der what you are.
""",
    },
    {
        'key': 'row-your-boat',
        'style': 'acoustic',
        'abc': """\
X:1
T:Row, Row, Row Your Boat
C:Traditional (public domain)
M:6/8
L:1/8
Q:3/8=66
K:C
"C"z6|"G"z6|
"C"C3 C3|C2 D E3|
w:Row, row, row your boat,
"C"E2 D E2 F|"G"G6|
w:gent-ly down the stream.
"C"c c c G G G|E E E C C C|
w:Mer-ri-ly, mer-ri-ly, mer-ri-ly, mer-ri-ly,
"G"G2 F E2 D|"C"C6|
w:life is but a dream.
""",
    },
    {
        'key': 'are-you-sleeping',
        'style': 'pop',
        'abc': """\
X:1
T:Are You Sleeping (Frere Jacques)
C:Traditional (public domain)
M:4/4
L:1/4
Q:1/4=110
K:C
"C"z4|"C"z4|
"C"C D E C|"C"C D E C|
w:Are you sleep-ing, are you sleep-ing,
"C"E F G2|"C"E F G2|
w:Bro-ther John, Bro-ther John?
"C"G/A/ G/F/ E C|"C"G/A/ G/F/ E C|
w:Morn-ing bells are ring-ing, morn-ing bells are ring-ing,
"C"C "G"G, "C"C2|"C"C "G"G, "C"C2|
w:ding, dang, dong, ding, dang, dong.
""",
    },
    {
        'key': 'ode-to-joy',
        'style': 'ballad',
        'language': 'de',
        'abc': """\
X:1
T:Ode an die Freude
C:Beethoven / Schiller (public domain)
M:4/4
L:1/4
Q:1/4=108
K:D
"D"z4|"A"z4|
"D"F F G A|"A"A G F E|
w:Freu-de, schö-ner Göt-ter-fun-ken,
"D"D D E F|"A"F3/2 E/ E2|
w:Toch-ter aus E-ly-si-um,
"D"F F G A|"A"A G F E|
w:wir be-tre-ten feu-er-trun-ken,
"D"D D E F|"A"E3/2 "D"D/ D2|
w:Himm-li-sche, dein Hei-lig-tum!
""",
    },
    {
        'key': 'sakura',
        'style': 'ballad',
        'language': 'ja',
        'abc': """\
X:1
T:さくら さくら
C:Traditional (public domain)
M:4/4
L:1/4
Q:1/4=72
K:Am
"Am"z4|"Am"z4|
"Am"A A B2|"Am"A A B2|
w:さ-く-ら さ-く-ら
"Am"A B c B|"Dm"A B/A/ "E"F2|
w:や-よ-い-の そ-ら_-は
"Am"E C E F|"E"E E/C/ B,2|
w:み-わ-た-す か-ぎ_-り
"Am"A B c B|"Dm"A B/A/ "E"F2|
w:か-す-み-か く-も_-か
"Am"E C E F|"E"E E/C/ B,2|
w:に-お-い-ぞ い-ず_-る
"Am"A A B2|"Am"A A B2|
w:い-ざ-や い-ざ-や
"Am"E F B/A/ F|"E"E4|
w:み-に-ゆ_-か-ん
""",
    },
]
