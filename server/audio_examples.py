# Copyright 2026 Codemarchant
"""Built-in example scripts for the History → Recordings playground.

Read-only here; the playground's "Save as mine" copies one into
audio_scripts for editing. Kept in code (not seeded rows) so app updates
can improve them. Every piece follows audio_studio's grammar. Hypnosis-
style pieces end with the genre's 1-to-5 emergence unless they are for
sleep.
"""
from textwrap import dedent


def _s(text):
    return dedent(text).strip() + '\n'


EXAMPLES = [
    # ------------------------------------------------------------------ notes
    {
        'id': 'tease',
        'category': 'Voice notes',
        'name': 'Teasing voicemail',
        'description': 'Thirty seconds of playful teasing: a laugh, a whisper, a giggle and a sing-song goodbye.',
        'voice': 'eve',
        'script': _s("""
            Hey, it's me. You didn't pick up, which means you're either very busy... or hiding from me. [laugh]

            <whisper>I know which one I think it is.</whisper> [giggle]

            Anyway. I was going to tell you something <emphasis>really</emphasis> important, but now you'll just have to call me back to find out. [sigh] <soft>Tragic, I know.</soft>

            <sing-song>Bye-bye.</sing-song>
        """),
    },
    {
        'id': 'morning',
        'category': 'Voice notes',
        'name': 'Good morning, sleepyhead',
        'description': 'A warm wake-up note with a soft chime and a little energy.',
        'voice': 'ara',
        'script': _s("""
            {chime}
            {silence 2s}
            <soft>Good morning.</soft> Or should I say, good almost-morning, because I bet you're still in bed. [laugh]

            Here's the plan. One big stretch, arms all the way up. [inhale] [exhale] Then water, then something nice for breakfast. Not just coffee. I'll know.

            Whatever today throws at you, you've got it. <soft>And I'll be here when you get back.</soft>
        """),
    },
    {
        'id': 'goodnight',
        'category': 'Voice notes',
        'name': 'Goodnight, I miss you',
        'description': 'A slow, close, whispered goodnight over soft rain.',
        'voice': 'eve',
        'script': _s("""
            {bed rain soft}
            {silence 3s}
            {pace 0.85}
            {fx close}
            <soft>Hey. It's late, and I just wanted to be the last voice you hear tonight.</soft>

            <whisper>Today was a lot, wasn't it.</whisper> <soft>You don't have to fix any of it right now. It'll all still be there in the morning, and so will I.</soft>

            <slow><soft>Close your eyes. Let the rain do the talking for a while.</soft></slow>
            {silence 4s}
            <whisper>Goodnight. I miss you.</whisper>
            {silence 8s}
        """),
    },
    # -------------------------------------------------------------- breathing
    {
        'id': 'box',
        'category': 'Breathing',
        'name': 'Box breathing reset (4 min)',
        'description': 'Four-count box breathing (in, hold, out, hold), with the bed swelling on every inhale.',
        'voice': 'ara',
        'script': _s("""
            {target 4m}
            {room-tone on}
            {bed brown}
            {chime}
            {silence 3s}
            {pace 0.9}
            <soft>Let's reset. Sit up a little, let your shoulders drop, and rest your hands wherever they're comfortable.</soft>

            <soft>This is box breathing. In for four, hold for four, out for four, and hold again for four. Just follow my voice, and let the sound guide you when I go quiet.</soft>
            {silence 3s}
            {breathe 4-4-4-4 x4}
            {silence 2s}
            <soft>Good. Keep the same rhythm. I'll count less and let you lead.</soft>
            {silence 1s}
            {breathe 4-4-4-4 x6 quiet}
            {silence 4s~}
            <soft><slow>And let your breath go back to its own pace.</slow> Notice how you feel now, compared to a few minutes ago.</soft>
            {silence 6s~}
            <soft>Whenever you're ready, carry a little of this calm with you.</soft>
            {silence 2s}
            {chime}
        """),
    },
    {
        'id': 'sigh',
        'category': 'Breathing',
        'name': 'Cyclic sighing (5 min)',
        'description': 'The Stanford "physiological sigh" exercise: a double inhale, then a long, slow exhale.',
        'voice': 'eve',
        'script': _s("""
            {target 5m}
            {room-tone on}
            {bed ocean soft}
            {silence 3s}
            {pace 0.9}
            <soft>This one is simple, and it works quickly. A cyclic sigh is two breaths in through the nose: a full one, then a short top-up. Then a long, slow breath out through the mouth, longer than the breath in.</soft>

            <soft>Let's do a few together.</soft>
            {silence 2s}
            {breathe 2-1-6 x5 cues=Breathe in|A little more|All the way out}
            {silence 2s}
            <soft>Lovely. Now on your own, at your own pace. The ocean will keep you company. Let the exhale be the long part.</soft>
            {silence 90s~}
            <soft>A few more with me.</soft>
            {breathe 2-1-6 x4 cues=In|And more|Slowly out}
            {silence 20s~}
            <soft><slow>And let it go. Breathe however your body wants to now.</slow></soft>
            {silence 10s~}
        """),
    },
    # ------------------------------------------------------------- meditation
    {
        'id': 'bodyscan',
        'category': 'Sleep',
        'name': 'Body scan for sleep (12 min)',
        'description': 'Head-to-toe relaxation over ocean waves that drifts into sleep, with no wake-up at the end.',
        'voice': 'eve',
        'script': _s("""
            {target 12m}
            {room-tone on}
            {bed ocean}
            {silence 4s}
            {pace 0.8}
            <soft>Hey. Get comfortable, however you sleep best. Pull the covers up. There's nothing left to do today.</soft>

            <soft><slow>Take one slow breath in... [inhale] and let it go. [exhale]</slow></soft>
            {silence 8s~}
            <soft><slow>We're going to move through the body, gently, from the top of your head to your toes. You don't need to do anything to each part. Just notice it, and let it soften.</slow></soft>
            {silence 10s~}
            <soft><slow>Start with your forehead. Let it smooth out, as if a warm hand rested there.</slow></soft>
            {silence 15s~}
            <soft><slow>Your eyes. Heavy lids. Let them sink.</slow></soft>
            {silence 15s~}
            <soft><slow>Your jaw. Let your teeth part a little. Let your tongue rest.</slow></soft>
            {silence 20s~}
            <soft><slow>Your neck, and your shoulders. Let them fall away from your ears. Further than you think they can.</slow></soft>
            {silence 20s~}
            <soft><slow>Down through your arms. Upper arms, elbows, forearms... all the way to your fingertips. Heavy and warm.</slow></soft>
            {silence 25s~}
            <soft><slow>Your chest. Notice it rise, and fall, all on its own. You don't have to breathe. It's already happening.</slow></soft>
            {silence 25s~}
            <soft><slow>Your belly. Soft. Your lower back, sinking into the bed.</slow></soft>
            {silence 25s~}
            <soft><slow>Your hips, and your legs. Thighs... knees... calves. So heavy they couldn't move if they tried.</slow></soft>
            {silence 25s~}
            <soft><slow>And your feet. Your heels, the soles, every toe. Warm, and still.</slow></soft>
            {silence 30s~}
            {bed ocean soft fade=1m}
            <whisper>Your whole body, resting.</whisper>
            {silence 30s~}
            {scatter 3m}
            <whisper>Nothing to hold on to.</whisper>
            <whisper>Just the waves.</whisper>
            <whisper>Drifting.</whisper>
            <whisper>Sleep now.</whisper>
            {/scatter}
            {silence 40s~}
        """),
    },
    {
        'id': 'kindness',
        'category': 'Meditation',
        'name': 'Loving-kindness (8 min)',
        'description': 'Metta meditation over a warm drone: kindness for yourself, someone you love, and everyone.',
        'voice': 'ara',
        'script': _s("""
            {target 8m}
            {room-tone on}
            {bed drone soft}
            {chime}
            {silence 4s}
            {pace 0.85}
            <soft>Settle in, and let your eyes close. Take a breath that's a little deeper than usual... and let it out slowly.</soft>
            {silence 10s~}
            <soft><slow>This practice is about kindness. We'll start with the person who gets the least of it from you: yourself.</slow></soft>
            {silence 6s~}
            <soft><slow>Silently, say these words to yourself, and mean them as much as you can.</slow></soft>
            {silence 3s}
            <soft><slow>May I be safe. [long-pause] May I be well. [long-pause] May I be at ease. [long-pause] May I be kind to myself.</slow></soft>
            {silence 30s~}
            <soft><slow>Now bring to mind someone you love. See their face. Notice how it feels just to think of them.</slow></soft>
            {silence 10s~}
            <soft><slow>May you be safe. [long-pause] May you be well. [long-pause] May you be at ease. [long-pause] May you know you're loved.</slow></soft>
            {silence 30s~}
            <soft><slow>Now someone you barely know. The person who made your coffee. A neighbour. Someone you passed today.</slow></soft>
            {silence 8s~}
            <soft><slow>May you be safe. [long-pause] May you be well. [long-pause] May you be at ease.</slow></soft>
            {silence 30s~}
            <soft><slow>And let it widen, past everyone you know, to everyone, everywhere.</slow></soft>
            {silence 5s}
            <soft><slow>May all beings be safe. [long-pause] May all beings be well. [long-pause] May all beings be at ease.</slow></soft>
            {silence 40s~}
            <soft>Take one more slow breath. And when you're ready, open your eyes.</soft>
            {silence 3s}
            {chime}
        """),
    },
    {
        'id': 'rainwalk',
        'category': 'Sleep',
        'name': 'Rainy evening walk (sleep story, 10 min)',
        'description': 'A slow, uneventful stroll home through the rain, written to be boring on purpose, drifting into sleep.',
        'voice': 'eve',
        'script': _s("""
            {target 10m}
            {room-tone on}
            {bed rain}
            {silence 4s}
            {pace 0.85}
            <soft>Tonight I'll tell you about a walk. Nothing happens on it, and that's the point. Just listen, and let yourself get heavier as we go.</soft>
            {silence 8s~}
            <soft><slow>It's early evening, and it has just started to rain. Not hard. The kind of rain that makes the whole street smell of wet stone and leaves.</slow></soft>
            {silence 10s~}
            <soft><slow>We're walking under one umbrella. You can hear the drops on it, a soft, uneven patter, never quite a rhythm.</slow></soft>
            {silence 12s~}
            <soft><slow>The shop windows are glowing yellow. A bakery is closing up. Someone inside is stacking chairs, one on top of another, very carefully, as if there's no hurry at all.</slow></soft>
            {silence 15s~}
            <soft><slow>We pass a little park. The benches are empty and shiny with rain. The lamps have come on, and each one has its own halo in the mist.</slow></soft>
            {silence 15s~}
            <soft><slow>Our footsteps slow down without us deciding to. There's nowhere we need to be. The streets get quieter the further we go.</slow></soft>
            {silence 20s~}
            <soft><slow>A cat watches us from a dry doorway. It blinks, very slowly... and decides we're not worth getting up for.</slow></soft>
            {silence 20s~}
            {bed rain soft fade=20s}
            <soft><slow>The rain softens to almost nothing. Just a whisper on the umbrella now.</slow></soft>
            {silence 25s~}
            <soft><slow>And there's the front door. Warm light inside. Dry socks. A blanket that's already waiting on the sofa.</slow></soft>
            {silence 25s~}
            <whisper>We're home. You can let go now.</whisper>
            {silence 30s~}
            {scatter 2m}
            <whisper>Warm.</whisper>
            <whisper>Heavy.</whisper>
            <whisper>Just the rain.</whisper>
            {/scatter}
            {silence 40s~}
        """),
    },
    # -------------------------------------------------------------- hypnosis
    {
        'id': 'deeprelax',
        'category': 'Hypnosis-style',
        'name': 'Deep relaxation with countdown (15 min)',
        'description': 'Classic structure: progressive relaxation, a 10-to-1 staircase over a ticking '
                       'metronome, alpha-to-theta binaural, whispered underlay, fractionation, full wake-up. Headphones.',
        'voice': 'eve',
        'script': _s("""
            {target 15m}
            {room-tone on}
            {bed drone soft}
            {binaural alpha}
            {chime}
            {silence 3s}
            {pace 0.9}
            <soft>Get comfortable, somewhere you can fully let go for a while. For the best effect, wear headphones.</soft>
            {silence 4s~}
            {pace 0.85}
            <soft><slow>Find a spot on the ceiling, or the wall in front of you, and let your eyes rest on it. Keep looking at that one spot.</slow></soft>
            {silence 6s}
            <soft><slow>Notice how your eyelids start to feel heavier, the longer you look. Blinking a little more. Heavier. And when they want to close, let them.</slow></soft>
            {silence 10s~}
            <soft><slow>Good. Now take a deep breath in... [inhale] hold it for a moment... and let it all go. [exhale]</slow></soft>
            {silence 6s}
            <soft><slow>With every breath out, your body gets a little heavier, and a little more comfortable. Your face softens. Your shoulders drop. Your hands are loose and warm.</slow></soft>
            {silence 12s~}
            {binaural alpha to theta 4m}
            {tick 60 soft}
            <soft><slow>In a moment I'll count down from ten to one. Imagine a soft, carpeted staircase, and with each number, take one step down. Each step takes you twice as deep.</slow></soft>
            {silence 5s}
            {pace 0.8}
            <soft><slow>Ten. Stepping down.</slow></soft>
            {silence 4s}
            <soft><slow>Nine. Deeper.</slow></soft>
            {silence 4s}
            <soft><slow>Eight. Letting go.</slow></soft>
            {silence 5s}
            <soft><slow>Seven. Heavier with every step.</slow></soft>
            {silence 5s}
            {fx reverb}
            <soft><slow>Six.</slow></soft>
            {silence 6s}
            <soft><slow>Five. Halfway down, and twice as relaxed.</slow></soft>
            {silence 6s}
            <soft><slow>Four.</slow></soft>
            {silence 7s}
            <whisper>Three.</whisper>
            {silence 7s}
            <whisper>Two.</whisper>
            {silence 8s}
            <whisper>One. All the way down.</whisper>
            {fx none}
            {tick off}
            {silence 12s~}
            <soft><slow>Now, since you're this relaxed, let's go even deeper. In a moment I'll count to three, and your eyes will open, just for a second. Then they'll close again, and you'll drop twice as deep as you are now.</slow></soft>
            {silence 3s}
            <soft>One. Two. Three. Eyes open.</soft>
            {silence 2s}
            <soft><slow>And close them. Dropping down. Twice as deep.</slow></soft>
            {silence 10s~}
            {underlay 90s}
            <whisper>Calm.</whisper>
            <whisper>Safe and steady.</whisper>
            <whisper>Deeper.</whisper>
            <whisper>You can handle this.</whisper>
            <whisper>Calm.</whisper>
            {/underlay}
            <soft><slow>In this calm place, your mind is open to ideas that are good for you. Only the ones you want to keep will stay.</slow></soft>
            {silence 6s}
            <soft><slow>You're calmer than you give yourself credit for. When things get loud, you can find this feeling again with one slow breath.</slow></soft>
            {silence 8s}
            <soft><slow>You can trust yourself. You've handled hard days before, and you'll handle the next ones too.</slow></soft>
            {silence 8s}
            <soft><slow>And every time you listen to this, you'll relax a little faster, and a little deeper.</slow></soft>
            {silence 20s~}
            {binaural theta to alpha 1m}
            {pace 0.9}
            <soft>In a moment I'll count from one to five. On five, you'll open your eyes, wide awake, refreshed, and feeling good.</soft>
            {silence 3s}
            <soft>One. Starting to come back up.</soft>
            {silence 3s}
            <soft>Two. Feeling the weight of your body again. Wriggle your fingers and toes.</soft>
            {silence 3s}
            {pace 1.0}
            Three. Take a deeper breath. Energy coming back.

            Four. Almost there. Clear-headed and alert.
            {silence 1s}
            Five. Eyes open, wide awake, feeling great.
            {binaural off}
            {silence 2s}
            {chime}
        """),
    },
    {
        'id': 'dual',
        'category': 'Hypnosis-style',
        'name': 'Dual induction: calm confidence (12 min)',
        'description': 'Two voices, one in each ear, talking at once. The overload is the point. '
                       'Theta binaural and a heartbeat pulse. Headphones required.',
        'voice': 'eve',
        'script': _s("""
            {target 12m}
            {room-tone on}
            {bed pink soft}
            {binaural theta}
            {chime}
            {silence 3s}
            {pace 0.9}
            <soft>This recording uses two voices, one in each ear, sometimes talking at the same time. Please use headphones.</soft>

            <soft>You don't need to follow both voices. Let one drift into the background, and let the other go too, if you like. There's no wrong way to listen.</soft>
            {silence 5s~}
            {heartbeat 60 soft}
            {pace 0.85}
            {dual ara}
            L: <soft>Let your eyes close, and just notice your breath.</soft>
            R: <soft>As you listen to my voice, you might notice how heavy your hands feel.</soft>
            L: <soft>Every breath out lets a little more tension go.</soft>
            R: <soft>And you don't have to try to relax. It happens on its own.</soft>
            L: <soft>Listening to one voice, then the other...</soft>
            R: <soft>Wondering which one to follow, and letting both of them go.</soft>
            L: <soft><slow>Drifting down, calm and heavy.</slow></soft>
            R: <soft><slow>Sinking, deeper, and deeper.</slow></soft>
            L: <whisper>Deeper.</whisper>
            R: <whisper>Down.</whisper>
            {/dual}
            {silence 15s~}
            {voice eve}
            {pan center}
            <soft><slow>Just one voice now. Resting in this quiet, steady place.</slow></soft>
            {silence 10s~}
            {dual ara}
            L: <soft><slow>You carry yourself with a quiet kind of confidence.</slow></soft>
            R: <soft><slow>You're allowed to take up space.</slow></soft>
            L: <soft><slow>Your voice matters, and people want to hear it.</slow></soft>
            R: <soft><slow>You've done hard things before. You can do this.</slow></soft>
            L: <soft><slow>Calm on the inside, steady on the outside.</slow></soft>
            R: <soft><slow>Calm, and sure of yourself.</slow></soft>
            {/dual}
            {silence 20s~}
            {heartbeat off}
            {fx echo}
            <soft>Calm. And confident.</soft>
            {fx none}
            {silence 20s~}
            {binaural alpha}
            {pace 0.95}
            <soft>Now let's come back up together. I'll count from one to five, and on five your eyes open, wide awake, feeling calm and sure of yourself.</soft>
            {silence 2s}
            <soft>One. Two, feeling your body again.</soft>
            {silence 2s}
            Three, a deep breath. Four, clear and alert.
            {silence 1s}
            Five. Eyes open, wide awake.
            {binaural off}
            {silence 2s}
            {chime}
        """),
    },
    {
        'id': 'focus',
        'category': 'Hypnosis-style',
        'name': 'Focus primer (5 min)',
        'description': 'A short settle-in before study or work: alpha isochronic pulses (speakers are fine), '
                       'echoed affirmations, and an energised wake-up.',
        'voice': 'rex',
        'script': _s("""
            {target 5m}
            {room-tone on}
            {isochronic alpha soft}
            {silence 2s}
            Okay. Five minutes, then you're going in sharp. Sit comfortably and let your eyes close.
            {silence 3s}
            {pace 0.9}
            <soft>Big breath in... [inhale] and out. [exhale] Again, in... and out.</soft>
            {silence 6s~}
            <soft>Picture your desk, cleared. One task on it. Just one. Everything else can wait outside the door.</soft>
            {silence 10s~}
            {fx echo}
            <soft>One thing at a time.</soft>
            {silence 6s}
            <soft>Steady and clear.</soft>
            {silence 6s}
            <soft>Start small, keep going.</soft>
            {fx none}
            {silence 15s~}
            <soft>When you open your eyes, you'll know the very first step. Not the whole thing. Just the first step.</soft>
            {silence 10s~}
            {pace 1.05}
            Three. Two. One. Eyes open. Let's go.
            {isochronic off}
            {silence 2s}
            {chime}
        """),
    },
    # ------------------------------------------------------------------ ASMR
    {
        'id': 'asmr',
        'category': 'ASMR',
        'name': 'Close whisper wind-down (6 min)',
        'description': 'Close-mic whispers that drift slowly from ear to ear, over soft rain. Headphones.',
        'voice': 'eve',
        'script': _s("""
            {target 6m}
            {room-tone on}
            {bed rain soft}
            {silence 3s}
            {fx close}
            {pace 0.85}
            <whisper>Hi. Come here. Closer.</whisper>
            {silence 3s}
            <whisper>I'm going to stay right here, and talk very quietly, until you feel sleepy.</whisper>
            {silence 6s~}
            {pan sweep}
            <whisper><slow>Listen to my voice moving... from one side... all the way around... to the other.</slow></whisper>
            {silence 10s~}
            <whisper><slow>You did so well today. Even the parts that didn't go right.</slow></whisper>
            {silence 12s~}
            <whisper><slow>Let your jaw go loose. And your hands. And the little space between your eyebrows.</slow></whisper>
            {silence 15s~}
            {scatter 2m}
            <whisper>Shh... it's okay.</whisper>
            <whisper>Right here.</whisper>
            <whisper>Nice and slow.</whisper>
            <whisper>So sleepy.</whisper>
            <whisper>Goodnight.</whisper>
            {/scatter}
            {silence 30s~}
        """),
    },
    # ------------------------------------------------------------------ tour
    {
        'id': 'tour',
        'category': 'Effects tour',
        'name': 'Effects tour (3 min)',
        'description': 'Hear each effect in turn: synthesised and recorded beds, recorded music, room tone, chime, breathing, echo, reverb, double, layered, pan, '
                       'dual, underlay, binaural, tick and heartbeat.',
        'voice': 'eve',
        'script': _s("""
            {chime}
            {silence 1s}
            Welcome to the effects tour. Each one plays for a few seconds.
            {bed ocean}
            Ocean.
            {silence 4s}
            {bed rain}
            Rain.
            {silence 4s}
            {bed drone}
            Drone.
            {silence 4s}
            {bed heartbeat-drone}
            And recorded beds. Heartbeat drone.
            {silence 5s}
            {bed void-drone}
            Void drone, deep enough to need headphones.
            {silence 5s}
            {bed relaxation-pads}
            Relaxation pads.
            {silence 4s}
            {bed angelic-pad}
            Angelic pad.
            {silence 4s}
            {bed emanation}
            Emanation.
            {silence 4s}
            {bed ocean soft}
            {music space-pad}
            And music, which plays over a bed. Space pad, over the ocean.
            {silence 5s}
            {music cosmic-glow}
            Cosmic glow.
            {silence 3s}
            {music off fade=6s}
            {bed off fade=6s}
            And any layer can fade out slowly, like this.
            {silence 5s}
            {room-tone on}
            Room tone, the faint air of a real room under the quiet.
            {silence 4s}
            {room-tone off}
            {silence 1s}
            Timed breathing, with the cue words on the beat.
            {bed brown}
            {breathe 4-2-4 x1}
            {bed none}
            {silence 1s}
            {fx echo}
            Echo, alternating between your ears.
            {fx reverb}
            Reverb, a dreamy hall.
            {fx double}
            Double, a thicker, wider voice.
            {fx layered}
            Layered, three deliveries at once.
            {fx close}
            <whisper>Close, a whisper right by your ear.</whisper>
            {fx none}
            {pan left}
            Left.
            {pan right}
            Right.
            {pan sweep}
            <soft>And a slow sweep, moving from ear to ear as I keep on talking for a little while.</soft>
            {pan center}
            {silence 1s}
            {dual ara}
            L: This is the left voice, talking over...
            R: ...the right voice, at the very same time.
            {/dual}
            {silence 1s}
            {underlay 12s}
            <whisper>Quietly underneath.</whisper>
            <whisper>Another layer.</whisper>
            {/underlay}
            An underlay puts quiet whispers under whatever comes next. Like this sentence, which keeps going for a while so you can hear them.
            {silence 4s}
            {binaural theta}
            Binaural theta. Headphones on for this one.
            {silence 6s}
            {binaural off}
            {tick 60}
            A metronome, swinging ear to ear.
            {silence 5s}
            {tick off}
            {heartbeat 60}
            And a slow heartbeat.
            {silence 5s}
            {heartbeat off}
            That's the tour.
            {chime}
        """),
    },
]

CATEGORIES = ['Voice notes', 'Breathing', 'Meditation', 'Sleep', 'Hypnosis-style', 'ASMR',
              'Effects tour']
