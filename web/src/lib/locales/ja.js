// Japanese UI dictionary. Keys are the English source strings passed to _t()
// — a missing key falls back to English, so partial coverage degrades
// gracefully. Model-facing strings (the "[System]:" call notes injected into
// the LLM context) are deliberately NOT translated: what the model receives
// stays English regardless of the UI language.
export const JA = {
  // ── App chrome ────────────────────────────────────────────────────────
  "Voice": "ボイス",
  "Chat": "チャット",
  "Games": "ゲーム",
  "Memories": "メモリ",
  "Settings": "設定",
  // First-run "no API key" banner
  "Companions talk through your own xAI (Grok) account: an API key billed by usage, or your SuperGrok or X Premium subscription.":
    "コンパニオンとの会話にはご自身の xAI（Grok）アカウントを使用します。利用量に応じて課金される API キーか、SuperGrok または X Premium のサブスクリプションを使えます。",
  "Add a key or sign in with Grok in Settings to get started - or run them on another provider or models on this computer (Settings → Models & providers).":
    "設定でキーを追加するか、Grok でサインインすると使い始められます。ほかのプロバイダーやこのコンピューター上のモデルで動かすこともできます（設定 → モデルとプロバイダー）。",
  "Get a key": "キーを取得",
  "Open Settings": "設定を開く",
  "Immersive": "没入モード",
  "Immersive view — hide all UI for a full-screen avatar (H · Esc to exit)":
    "没入ビュー — UI をすべて隠してアバターを全画面表示（H で切替 · Esc で終了）",
  "Immersive view — hide all UI (H · Esc to exit)":
    "没入ビュー — UI をすべて隠す（H で切替 · Esc で終了）",

  // ── Desktop mascot (pop-out overlay) ──────────────────────────────────
  "Pop out — float the avatar in a small always-on-top window":
    "ポップアウト — アバターを小さな最前面ウィンドウに切り離す",
  "Drag to move": "ドラッグで移動",
  "Always on top": "常に最前面",
  "Cycle window size — or scroll on the avatar for fine control":
    "ウィンドウサイズを切り替え — アバター上でスクロールすると微調整できます",
  "Transcript": "トランスクリプト",
  "Drop files to attach": "ここにドロップしてファイルを添付",
  "Open the transcript in its own window": "トランスクリプトを別ウィンドウで開く",
  "Waiting for an active call…": "通話の開始を待っています…",
  "Start or resume a call in the app (or the desktop avatar) and the conversation appears here.":
    "アプリ（またはデスクトップのアバター）で通話を開始・再開すると、会話がここに表示されます。",
  "Back to the app window": "アプリウィンドウに戻る",
  "Ghost mode — clicks pass through the window; the avatar steps out of the cursor's way":
    "ゴーストモード — クリックはウィンドウを素通りし、アバターはカーソルを避けてフェードします",
  "Could not open picture-in-picture: %s":
    "ピクチャーインピクチャーを開けませんでした: %s",

  // ── Settings: HTTPS / LAN access ──────────────────────────────────────
  "VR headset & other devices (HTTPS)": "VR ヘッドセット・他のデバイス（HTTPS）",
  "Turn this on to use Rexclaw on other devices on your WiFi: in VR from a headset's browser (Quest, Pico), or on a phone or tablet (iPhone, iPad, Android), where you can also add it to the home screen. Open the URL shown here on the device and accept its one-time certificate warning. If the system firewall asks, allow access. Switching it on restarts the app's server in HTTPS mode and reloads this window.":
    "オンにすると、同じ WiFi 上の他のデバイスで Rexclaw を使えます。ヘッドセットのブラウザ（Quest、Pico）から VR で、またはスマートフォンやタブレット（iPhone、iPad、Android）で利用でき、ホーム画面に追加することもできます。ここに表示される URL をデバイスで開き、初回のみ表示される証明書の警告を承認してください。システムのファイアウォールに確認されたら、アクセスを許可してください。オンにするとアプリのサーバーが HTTPS モードで再起動し、このウィンドウが再読み込みされます。",
  "Serve over HTTPS on WiFi": "WiFi 上で HTTPS 配信",
  "Open this URL on the device (headset, phone, tablet)":
    "この URL をデバイス（ヘッドセット・スマホ・タブレット）で開く",
  "On": "オン",
  "Off": "オフ",

  // ── Shared bits ───────────────────────────────────────────────────────
  "Loading…": "読み込み中…",
  "Ready": "準備完了",
  "Connecting…": "接続中…",
  "Live": "通話中",
  "Muted (live)": "ミュート中（通話中）",
  "Ending…": "終了中…",
  "Ended": "終了",
  "Error": "エラー",
  "Error:": "エラー：",
  "Dismiss": "閉じる",
  "History": "履歴",
  "Resume": "再開",
  "Resume %s": "%s を再開",
  "Resume last": "前回を再開",
  "Start": "開始",
  "End": "終了",
  "Send": "送信",
  "Save": "保存",
  "Cancel": "キャンセル",
  "Edit": "編集",
  "Add": "追加",
  "Remove": "削除",
  "Replace": "差し替え",
  "Upload": "アップロード",
  "None": "なし",
  "Low": "低",
  "Medium": "中",
  "High": "高",
  "messages": "件のメッセージ",
  "Name": "名前",
  "Compacting context…": "コンテキストを圧縮中…",
  "summarising…": "要約中…",
  "Over the threshold — the summary is being written in the background; the counter resets once it is applied at the next quiet moment.":
    "しきい値を超えています — バックグラウンドで要約を作成中です。次の静かなタイミングで適用されるとカウンターがリセットされます。",
  "Type a message…": "メッセージを入力…",
  "Upload failed": "アップロードに失敗しました",
  "Save failed": "保存に失敗しました",
  "Delete failed": "削除に失敗しました",
  "unknown": "不明",
  "unknown error": "不明なエラー",

  // ── Voice view ────────────────────────────────────────────────────────
  "No previous sessions yet.": "まだセッション履歴はありません。",
  "Hide history": "履歴を隠す",
  "The companion's prompt, persona or memories changed — refresh this conversation to use the latest version":
    "コンパニオンのプロンプト・人格・記憶が変更されました — この会話を更新して最新版を使う",
  "The companion's prompt, persona or memories have changed since this conversation's context was set up, and the ongoing chat is still using the older version.\n\nRefresh it? Your next message will re-send the full conversation once (extra tokens for that one turn), and every reply after that uses the latest version.":
    "この会話のコンテキストが設定されて以降、コンパニオンのプロンプト・人格・記憶が変更されましたが、進行中のチャットはまだ古い版を使っています。\n\n更新しますか？ 次のメッセージで会話全体が一度だけ再送信され（そのターンのみトークンが追加でかかります）、以降の返答はすべて最新版を使います。",
  "Could not refresh the prompt": "プロンプトを更新できませんでした",
  "Show history": "履歴を表示",
  "Switch to face view": "顔アップ表示に切り替え",
  "Switch to full body (drag to rotate, scroll to zoom, Shift + drag to move)":
    "全身表示に切り替え（ドラッグで回転、スクロールでズーム、Shift＋ドラッグで移動）",
  "Disable walk mode": "歩行モードを無効化",
  "Enable walk mode (WASD / arrow keys — number keys pick which character to move in a group call)":
    "歩行モードを有効化（WASD／矢印キー — グループ通話中は数字キーで操作キャラを選択）",
  "Hide walk mode settings": "歩行モード設定を隠す",
  "Walk mode settings (mode, reset, position)": "歩行モード設定（モード・リセット・位置）",
  "Walk": "歩行",
  "Moves the companion. It stays facing however it stopped, so you can pose it":
    "コンパニオンを移動させます。停止した向きのままになるので、ポーズ付けができます",
  "Camera - auto follow": "カメラ（自動追従）",
  "Walks the companion like Walk, while the camera directs itself: it follows them and changes shot (face, waist-up, full body) when they finish a line or set off walking. Drag or zoom to take the camera back until the next shot":
    "「歩行」と同じようにコンパニオンを歩かせながら、カメラが自動で演出します。コンパニオンを追いかけ、話し終えたときや歩き始めたときにショット（顔、上半身、全身）を切り替えます。ドラッグやズームをすると、次のショットまでカメラを自分で操作できます",
  "Camera": "カメラ",
  "Flies the camera itself; companions untouched":
    "カメラ自体を移動させます。コンパニオンには影響しません",
  "Reset to this scene's default position (discards any hand-placed spot) and its default camera framing":
    "このシーンのデフォルト位置（手動配置は破棄されます）とデフォルトのカメラアングルにリセットします",
  "Reset to default": "デフォルトにリセット",
  "Make the CURRENT position/facing this scene's new default spawn point for everyone":
    "現在の位置・向きを、このシーンの新しいデフォルトスポーン地点として全員に適用します",
  "Set as default": "デフォルトとして設定",
  "facing": "向き",
  "Could not save the default position.": "デフォルト位置を保存できませんでした。",
  "Enter MR/VR — passthrough mixed reality (toggle Virtual/Passthrough on the in-headset panel)":
    "MR/VR に入る — パススルー複合現実（ヘッドセット内パネルでバーチャル／パススルーを切替）",
  "Enter VR — stand with your companion in a headset (passthrough MR unavailable on this browser)":
    "VR に入る — ヘッドセットでコンパニオンと同じ空間へ（このブラウザではパススルー MR は利用不可）",
  "Hide manual triggers": "手動トリガーを隠す",
  "Show manual emotion/gesture triggers": "感情／ジェスチャーの手動トリガーを表示",
  "Hide agent selector + call controls": "エージェント選択と通話コントロールを隠す",
  "Show agent selector + call controls": "エージェント選択と通話コントロールを表示",
  "Hide transcript (full-width avatar)": "トランスクリプトを隠す（アバターを全幅表示）",
  "Show transcript": "トランスクリプトを表示",
  "Tokens used since the last summary rollup, over the configured auto-compact threshold.":
    "前回の要約以降に使用したトークン数／自動圧縮しきい値。",
  "Emotions": "感情",
  "Gestures": "ジェスチャー",
  "Custom Gestures": "カスタムジェスチャー",
  "(combo)": "（コンボ）",
  "(loops)": "（ループ）",
  "Outfit": "衣装",
  "Background": "背景",
  "Default Background": "デフォルト背景",
  "Imagine background": "Imagine 背景",
  "Mute": "ミュート",
  "Unmute": "ミュート解除",
  "Main avatar": "メインアバター",
  "Companion": "コンパニオン",
  "Walk control: %s": "歩行操作：%s",
  "Could not start VR: %s": "VR を開始できませんでした：%s",
  "Say something to get started.": "話しかけて会話を始めましょう。",
  "Type a message to get started.": "メッセージを入力して会話を始めましょう。",
  "Earlier messages not shown": "これ以前のメッセージは表示されていません",
  "Earlier messages exist on the server but are not loaded in this view.":
    "これ以前のメッセージはサーバーに保存されていますが、このビューには読み込まれていません。",
  "Generated image": "生成画像",
  "Generated video": "生成動画",
  "Reply was truncated by xAI: %s": "応答が xAI により途中で打ち切られました：%s",
  "Stopped searching after %s searches; this reply was written without them.":
    "%s 回検索したところで検索を止め、この返信は検索結果なしで書かれました。",
  "search limit": "検索上限",

  // ── Group calls ───────────────────────────────────────────────────────
  "Agent": "エージェント",
  "%s is in this call": "%s が通話に参加中",
  "Remove from call": "通話から外す",
  "Add another agent to the call": "通話にエージェントを追加",
  "Add agent to call…": "通話にエージェントを追加…",
  "Add the selected agent to this call": "選択したエージェントをこの通話に追加",
  "Start a call before adding another agent.": "エージェントを追加する前に通話を開始してください。",
  "Unknown agent.": "不明なエージェントです。",
  "That agent is already in the call.": "そのエージェントはすでに通話に参加しています。",
  "That companion is not currently in the call.": "そのコンパニオンは現在通話に参加していません。",
  "The main companion of this call cannot be removed — only the user can end the call itself.":
    "この通話のメインコンパニオンは外せません — 通話自体の終了はユーザーのみが行えます。",
  "Could not add the agent to the call.": "エージェントを通話に追加できませんでした。",
  "Another companion": "別のコンパニオン",
  "Assistant": "アシスタント",
  "User": "ユーザー",

  // ── Voice session errors / notices ────────────────────────────────────
  "Microphone unavailable — session is muted. You can type instead, or click Unmute to retry.":
    "マイクを利用できません — セッションはミュート中です。テキスト入力するか、「ミュート解除」で再試行できます。",
  "Microphone disconnected — session muted. Click Unmute to retry.":
    "マイクが切断されました — セッションをミュートしました。「ミュート解除」で再試行してください。",
  "Microphone setup failed: ": "マイクの初期化に失敗しました：",
  "Could not open WebSocket: ": "WebSocket を開けませんでした:",
  "Voice connection closed (%s)": "音声接続が閉じられました（%s）",
  "Voice connection closed (%s): %s": "音声接続が閉じられました（%s）：%s",
  "Failed to start session": "セッションを開始できませんでした",
  "End the current voice session before starting a new one.":
    "新しいセッションを始める前に、現在の音声セッションを終了してください。",
  "Connect first before sending a typed message.": "メッセージを送る前に、まず接続してください。",
  "Tool dispatcher missing.": "ツールディスパッチャーがありません。",
  "Tool round-trip cap reached.": "ツール呼び出し回数の上限に達しました。",
  "The agent hit a problem: %s%s": "エージェントで問題が発生しました：%s%s",
  "The agent stalled mid-reply. Try rephrasing your request.":
    "エージェントが応答の途中で停止しました。言い方を変えて試してください。",
  "This conversation reached its maximum length and is ending.":
    "この会話は最大長に達したため終了します。",
  "Auto-compact failed: ": "自動圧縮に失敗しました：",
  "Compact skipped: ": "圧縮をスキップしました：",
  "Compacting context — try again in a moment.": "コンテキストを圧縮中です — 少し待ってからもう一度お試しください。",
  "Couldn't load tools from %s — %s. The agent won't be able to query your data this session.":
    "%s からツールを読み込めませんでした — %s。このセッションではエージェントはデータへ問い合わせできません。",
  "the MCP server": "MCP サーバー",
  "Daily token allowance reached.": "1日のトークン上限に達しました。",
  "Daily voice token allowance reached. Ending session.":
    "1日の音声トークン上限に達しました。セッションを終了します。",
  "You're approaching your daily voice token allowance.": "1日の音声トークン上限が近づいています。",

  // ── Text view ─────────────────────────────────────────────────────────
  "No previous chats yet.": "まだチャット履歴はありません。",
  "Start chat": "チャット開始",
  "Start new": "新規開始",
  "New chat": "新規チャット",
  "Light theme": "ライトテーマ",
  "Dark theme": "ダークテーマ",
  "Attach a file": "ファイルを添付",
  "Emoji": "絵文字",
  "Tokens used since the last summary rollup.": "前回の要約以降に使用したトークン数。",
  "No active chat session.": "アクティブなチャットセッションがありません。",
  "End the current chat before starting a new one.":
    "新しいチャットを始める前に、現在のチャットを終了してください。",
  "Failed to start chat session": "チャットセッションを開始できませんでした",
  "Chat request failed.": "チャットリクエストに失敗しました。",
  "Send failed": "送信に失敗しました",
  "Unknown server response.": "サーバーから不明な応答が返されました。",
  "Approaching your daily text-chat token cap.": "1日のテキストチャットのトークン上限が近づいています。",
  "Daily text-chat token allowance reached.": "1日のテキストチャットのトークン上限に達しました。",

  // ── Memories view ─────────────────────────────────────────────────────
  "Durable facts and conversation episodes your companions remember across sessions — yours to review or forget at any time.":
    "コンパニオンがセッションをまたいで記憶している事実と会話エピソードです — いつでも確認・削除できます。",
  "Search memories, keywords, tags…": "メモリ・キーワード・タグを検索…",
  "All": "すべて",
  "Facts": "事実",
  "Episodes": "エピソード",
  "Filter by scope": "スコープで絞り込み",
  "All scopes": "すべてのスコープ",
  "Core": "コア",
  "Recall": "リコール",
  "Nothing remembered yet — companions store durable facts and episodes here as you talk.":
    "まだ何も記憶されていません — 会話するうちに、コンパニオンがここに事実やエピソードを保存していきます。",
  "No memories match your filters.": "条件に一致するメモリはありません。",
  "episode": "エピソード",
  "fact": "事実",
  "transcript": "トランスクリプト",
  "hide transcript": "トランスクリプトを隠す",
  "all companions": "全コンパニオン",
  "Forget": "忘れる",
  "Could not load memories": "メモリを読み込めませんでした",
  "Export": "エクスポート",
  "Import": "インポート",
  "Shared only": "共有のみ",
  "Download memories as a JSON file (follows the companion filter)":
    "メモリを JSON ファイルとしてダウンロード（コンパニオンの絞り込みに従います）",
  "Import memories from an exported JSON file": "エクスポートした JSON ファイルからメモリをインポート",
  "Export failed": "エクスポートに失敗しました",
  "Import failed": "インポートに失敗しました",
  "Not a valid JSON file.": "有効な JSON ファイルではありません。",
  "Imported %s memories (%s duplicates skipped).": "%s 件のメモリをインポートしました（重複 %s 件をスキップ）。",
  "Skipped memories of unknown companions: %s. Create them, then import again.":
    "存在しないコンパニオンのメモリをスキップしました: %s。コンパニオンを作成してから、もう一度インポートしてください。",
  // Memory Galaxy
  "View": "表示",
  "List view": "リスト表示",
  "List": "リスト",
  "Galaxy": "銀河",
  "See memories as a star map, grouped by what they're about": "メモリを話題ごとにまとめた星図として表示",
  "Memory Galaxy": "メモリ銀河",
  "%s memories · %s topics": "メモリ %s 件 · 話題 %s 個",
  "since %s": "%s から",
  "%s matches": "%s 件ヒット",
  "Topics": "話題",
  "Memories with no close neighbours drift around the edge.": "近い話題のないメモリは銀河の外側を漂います。",
  "stray stars": "はぐれ星",
  "Back to the whole sky": "全体表示に戻る",
  "Full screen": "全画面",
  "Exit full screen": "全画面を終了",
  "core": "コア",
  "recently recalled": "最近思い出した",
  "Remembered %s": "記憶した日時: %s",
  "Last recalled %s": "最後に思い出した日時: %s",
  "Connected memories": "つながりのあるメモリ",
  "Pause": "一時停止",
  "Replay": "リプレイ",
  "Replay how these memories formed, oldest first": "メモリが生まれた順に、古いものから再生",
  "Scrub through time": "時間をさかのぼる",
  // Recordings (audio studio)
  "Recordings": "録音",
  "Recording studio": "録音スタジオ",
  "Write or pick a script and render it with any xAI voice: voice notes, meditations, breathing exercises, sleep stories and hypnosis-style sessions. Directive lines in braces add timed silence, breathing, ambient sound and effects. Companions write the same kind of script when they send you a voice message in chat.":
    "台本を書くか選んで、好きな xAI ボイスで音声にします。ボイスメッセージ、瞑想、呼吸法、睡眠ストーリー、催眠風セッションなど。波かっこの指示行で、時間どおりの無音、呼吸ガイド、環境音、エフェクトを加えられます。コンパニオンがチャットでボイスメッセージを送るときも、同じ形式の台本を書きます。",
  "Could not load the recordings": "録音を読み込めませんでした",
  "New script": "新しい台本",
  "My scripts": "マイ台本",
  "None yet. Open an example and choose 'Save as my script' to make it yours.":
    "まだありません。サンプルを開いて「マイ台本として保存」を選ぶと、自分用に編集できます。",
  "Voice notes": "ボイスメッセージ",
  "Breathing": "呼吸法",
  "Meditation": "瞑想",
  "Sleep": "睡眠",
  "Hypnosis-style": "催眠風",
  "ASMR": "ASMR",
  "Effects tour": "エフェクト紹介",
  "Built-in example: edit freely, then save it as your own script to keep the changes.":
    "組み込みのサンプルです。自由に編集でき、変更を残すにはマイ台本として保存してください。",
  "e.g. 'Sunday wind-down'": "例: 「日曜の夜のリラックス」",
  "The speaker for the script. {voice …} lines inside the script can switch voices part-way, and {dual …} picks the second voice.":
    "台本の話し手です。台本内の {voice …} 行で途中から声を切り替えられ、{dual …} で2人目の声を選べます。",
  "xAI voices": "xAI ボイス",
  "Your custom voices": "カスタムボイス",
  "female": "女性",
  "male": "男性",
  "Starting speech speed (0.7–1.5). {pace …} lines in the script override it from that point on.":
    "最初の話す速さ（0.7〜1.5）。台本内の {pace …} 行があると、そこから先はその値になります。",
  "Base pace": "基本の速さ",
  "Script": "台本",
  "Full guide: how scripts work, every speech tag and directive": "完全ガイド: 台本の仕組み、全スピーチタグと指示行",
  "How a script works": "台本の仕組み",
  "Speech tags": "スピーチタグ",
  "Used inside spoken lines. This is xAI's complete list.": "読み上げる行の中で使います。xAI の全タグ一覧です。",
  "Inline: placed where the sound happens": "インライン: 音を入れたい位置に置く",
  "Wrapping: around whole phrases": "囲み: フレーズ全体を囲む",
  "Directives": "指示行",
  "Values (UPPERCASE words in a directive are values you fill in)": "値（指示行の大文字の語は、自分で入れる値です）",
  "required": "必須",
  "optional": "任意",
  "Writing rules": "書き方のルール",
  "Your sounds": "マイサウンド",
  "Delete": "削除",
  "Description": "説明",
  "Add a sound": "サウンドを追加",
  "Add sound": "追加",
  "Uploading…": "アップロード中…",
  "No sounds yet.": "まだサウンドがありません。",
  "File": "ファイル",
  "Kind": "種類",
  "Bed loop": "ベッド（ループ）",
  "Music": "音楽",
  "Sound effect": "効果音",
  "Default level (dB)": "デフォルト音量（dB）",
  "Credit / licence": "クレジット／ライセンス",
  "What scripts call it: lowercase letters, digits and hyphens.": "台本から呼ぶ名前です。小文字の英字・数字・ハイフンが使えます。",
  "Which directive plays it: a looping bed, a looping music layer that can play alongside a bed, or a one-shot effect.":
    "どの指示行で鳴らすか。ループするベッド、ベッドと同時に流せるループ音楽、1回だけ鳴る効果音から選びます。",
  "Default loudness change in dB, from -24 to 12. A script's own level adds to it.":
    "デフォルトの音量変化（dB、-24〜12）。台本で指定した音量はこれに加算されます。",
  "Companions read this to decide when to use the sound, so say what it sounds like and what it suits.":
    "コンパニオンはこの説明を読んで使いどころを判断します。どんな音で、何に合うかを書いてください。",
  "e.g. 'slow, warm synth pad, dreamy; good under an induction'": "例: 「ゆっくりした温かいシンセパッド、夢見心地。導入部の下に」",
  "For your own records: who made it, where it came from, its licence.": "自分用の記録です。作者、入手先、ライセンスなど。",
  "e.g. 'Kevin MacLeod, CC BY 4.0, incompetech.com'": "例: 「Kevin MacLeod, CC BY 4.0, incompetech.com」",
  "Upload your own beds, music and sound effects (WAV, FLAC, OGG or MP3). Scripts call them by name, and companions see each one with your description in their guide, so they can use it in voice messages. Only upload audio you have the rights to use.":
    "自分のベッド音、音楽、効果音をアップロードできます（WAV・FLAC・OGG・MP3）。台本から名前で呼び出せ、コンパニオンのガイドにも説明つきで表示されるので、ボイスメッセージで使ってもらえます。使用する権利のある音声だけをアップロードしてください。",
  "Beds and music loop under the voice until changed: a new {bed NAME} or {music NAME} crossfades to it, and {bed off} or {music off} stops it (add fade=10s for a slower fade). A sound effect plays once, and by default the script waits for it to finish so it is heard on its own. Add a length to cut it short ({sound thunder 5s}), or add under to play it beneath the next lines without waiting ({sound rain under}).":
    "ベッドと音楽は、変更されるまで声の下でループします。新しい {bed NAME} や {music NAME} でクロスフェードして切り替わり、{bed off} や {music off} で止まります（fade=10s を付けるとゆっくりフェードします）。効果音は1回だけ鳴り、デフォルトでは台本がその終わりを待つので、単独で聞こえます。長さを付けると途中で止まり（{sound thunder 5s}）、under を付けると待たずに次の行の下で鳴ります（{sound rain under}）。",
  "Could not save the sound": "サウンドを保存できませんでした",
  "Delete the sound '%s'? Scripts that use it will render without it, with a warning.":
    "サウンド「%s」を削除しますか？これを使う台本は、警告つきでこのサウンドなしで生成されます。",
  "Renaming breaks scripts that call the old name; they render without it, with a warning.":
    "名前を変えると、古い名前を呼ぶ台本ではこのサウンドが鳴らなくなります（警告が出ます）。",
  "(no description)": "（説明なし）",
  "None uploaded yet. Add some under Your sounds below; they appear here and in the companions' guide.":
    "まだアップロードされていません。下の「マイサウンド」で追加すると、こことコンパニオンのガイドに表示されます。",
  "All categories (%s)": "すべてのカテゴリー（%s）",
  "All companions (%s)": "すべてのコンパニオン（%s）",
  "Search names, voices, companions, script text…": "名前・ボイス・コンパニオン・台本の本文を検索…",
  "%s of %s recordings": "%s / %s 件の録音",
  "No recordings match.": "一致する録音はありません。",
  "How sounds play in a script": "台本でのサウンドの鳴り方",
  "Search names, descriptions, credits…": "名前・説明・クレジットを検索…",
  "All kinds (%s)": "すべての種類（%s）",
  "%s of %s sounds": "%s / %s 件のサウンド",
  "No sounds match.": "一致するサウンドはありません。",
  "Studio recordings": "スタジオの録音",
  "From companions": "コンパニオンから",
  "Custom": "カスタム",
  "Default": "デフォルト",
  "Override": "上書き",
  "Save rules": "ルールを保存",
  "Could not save the rules": "ルールを保存できませんでした",
  "Replace your writing rules with the defaults?": "書き方のルールをデフォルトに戻しますか？",
  "Companions follow these rules whenever they write a recording. Override them with your own style of rules; Reset to default brings back the built-in ones.":
    "コンパニオンは録音の台本を書くとき、このルールに従います。自分のスタイルのルールで上書きでき、「デフォルトにリセット」で組み込みのルールに戻せます。",
  "Pick a fully supported language from the list, or type any other language code (e.g. nl for Dutch): other languages work too, with varying accuracy.":
    "一覧から完全対応の言語を選ぶか、ほかの言語コードを入力してください（例: オランダ語は nl）。一覧にない言語も使えますが、精度はまちまちです。",
  "Auto-detect": "自動検出",
  "English": "英語",
  "Arabic (Egypt)": "アラビア語（エジプト）",
  "Arabic (Saudi Arabia)": "アラビア語（サウジアラビア）",
  "Arabic (United Arab Emirates)": "アラビア語（アラブ首長国連邦）",
  "Bengali": "ベンガル語",
  "Chinese (Simplified)": "中国語（簡体字）",
  "French": "フランス語",
  "German": "ドイツ語",
  "Hindi": "ヒンディー語",
  "Indonesian": "インドネシア語",
  "Italian": "イタリア語",
  "Japanese": "日本語",
  "Korean": "韓国語",
  "Portuguese (Brazil)": "ポルトガル語（ブラジル）",
  "Portuguese (Portugal)": "ポルトガル語（ポルトガル）",
  "Russian": "ロシア語",
  "Spanish (Mexico)": "スペイン語（メキシコ）",
  "Spanish (Spain)": "スペイン語（スペイン）",
  "Turkish": "トルコ語",
  "Vietnamese": "ベトナム語",
  "Examples": "例",
  "A voice note: short pieces need no directives.": "ボイスメモ: 短いものに指示行は要りません。",
  "A six-minute hypnosis-style session: arrival with music over a bed, breathing, a chime-marked crossfade into the trance bed, countdown with reverb and layered voices, a dual-induction deepener, suggestions with underlay, a close sweeping whisper and one echoed key phrase, crossfade to wake-up music, count-up.":
    "6分の催眠風セッション: ベッドに音楽を重ねた導入、呼吸、チャイムを合図にトランス用ベッドへクロスフェード、リバーブと重ね声のカウントダウン、デュアル誘導による深化、アンダーレイつきの暗示、耳元を巡るささやき、要となる一言のエコー、目覚めの音楽へクロスフェード、カウントアップ。",
  "Open this example in the editor": "この例をエディターで開く",
  "Guide example": "ガイドの例",
  "Category": "カテゴリー",
  "Where the script is filed in the library when you save it: one of the built-in sections, one of your own, or a new one.":
    "保存したときにライブラリのどこに入れるか。組み込みのセクション、自分で作ったもの、または新しいカテゴリーを選べます。",
  "New category…": "新しいカテゴリー…",
  "New category name": "新しいカテゴリー名",
  "Back to the list": "一覧に戻る",
  "Name the new category first.": "先に新しいカテゴリーの名前を付けてください。",
  "Your script": "あなたの台本",
  "Rendering… %ss": "生成中… %s 秒",
  "Generate": "生成",
  "Keep this script in 'My scripts' to edit and reuse it": "この台本をマイ台本に保存して、編集・再利用できるようにします",
  "Save as my script": "マイ台本として保存",
  "xAI bills text-to-speech at $15 per million characters. Layered and dual lines are spoken more than once, so they cost a little more.":
    "xAI の音声合成は100万文字あたり $15 で課金されます。layered と dual の行は複数回読み上げるため、少し多めにかかります。",
  "%s speech characters · about $%s": "読み上げ %s 文字 · 約 $%s",
  "Long pieces take a minute or more: the speech is voiced in parallel, then mixed.":
    "長い作品は1分以上かかります。読み上げを並行して生成してからミックスします。",
  "Nothing recorded yet. Generate one above, or ask a companion for a voice message in chat.":
    "まだ録音がありません。上で生成するか、チャットでコンパニオンにボイスメッセージを頼んでみてください。",
  "from %s": "%s から",
  "a companion": "コンパニオン",
  "Open the script in the editor": "台本をエディターで開く",
  "Download the mp3": "mp3 をダウンロード",
  "Give the script a name first.": "先に台本の名前を付けてください。",
  "Could not save the script": "台本を保存できませんでした",
  "Delete the script '%s'? Recordings made from it are kept.": "台本「%s」を削除しますか？この台本から作った録音は残ります。",
  "Delete the recording '%s'? The audio file is removed too.": "録音「%s」を削除しますか？音声ファイルも削除されます。",
  "Discard the unsaved changes to this script?": "この台本の未保存の変更を破棄しますか？",
  "Untitled recording": "無題の録音",
  "Rendering failed": "生成に失敗しました",
  "Voice message": "ボイスメッセージ",
  "Voice messages (create_voicemail)": "ボイスメッセージ（create_voicemail）",
  "Lets the companion record audio messages in its own voice during text chat (create_voicemail): teasing voice notes, good-morning messages, bedtime stories, guided meditations and breathing exercises, with timed silences, ambient sound and effects. The recording plays inline in the chat and is also listed under History → Recordings. Text sessions only. Billed by xAI as text-to-speech, about a cent per minute of speech.":
    "テキストチャット中に、コンパニオンが自分の声で音声メッセージを録音できるようにします（create_voicemail）。からかい半分のボイスメモ、おはようメッセージ、寝る前のお話、誘導瞑想、呼吸法など。時間どおりの無音、環境音、エフェクトも使えます。録音はチャット内で再生でき、履歴 → 録音 にも一覧表示されます。テキストセッションのみ。xAI の音声合成として課金され、読み上げ1分あたり約1セントです。",

  // ── Settings: connection / models ─────────────────────────────────────
  "Could not load settings": "設定を読み込めませんでした",
  "Could not load companions": "コンパニオンを読み込めませんでした",
  "Settings saved.": "設定を保存しました。",
  "xAI connection": "xAI 接続",
  "Restore suggested models": "推奨モデルに戻す",
  "Fill every model field with the ids this version of Rexclaw ships with and is tested against. Save to apply.": "このバージョンの Rexclaw に同梱され、動作確認済みのモデル ID をすべてのモデル欄に入れます。保存すると反映されます。",
  "See all models": "すべてのモデルを見る",
  "List every model your xAI key can reach, by kind. For reference — not every model suits every field.": "xAI キーで利用できるモデルを種類別に一覧表示します。参考用です — すべてのモデルがすべての欄に適しているわけではありません。",
  "Could not load the suggested models.": "推奨モデルを読み込めませんでした。",
  "Could not load models.": "モデルを読み込めませんでした。",
  "Available models": "利用可能なモデル",
  "Every model your key can reach, grouped by kind. Type the id you want into the matching field above — not every model suits every field (e.g. coding or reasoning-only models won't work as the text model).": "キーで利用できるすべてのモデルを種類別に表示しています。使いたい ID を上の該当する欄に入力してください。すべてのモデルがすべての欄に適しているわけではありません（例：コーディング専用や推論専用モデルはテキストモデルとして動作しません）。",
  "Voice models": "音声モデル",
  "Text models": "テキストモデル",
  "Image models": "画像モデル",
  "Video models": "動画モデル",
  "None returned for your key.": "このキーでは返されませんでした。",
  "alias": "エイリアス",
  "Close": "閉じる",
  "API key": "API キー",
  "saved": "保存済み",
  "•••••••• (leave blank to keep current key)": "••••••••（空欄のままなら現在のキーを維持）",
  "Voice model": "音声モデル",
  "Grok subscription": "Grok サブスクリプション",
  "Sign in with Grok": "Grok でサインイン",
  "Signed in": "サインイン済み",
  "Signed in as": "サインイン中：",
  "Show account": "アカウントを表示",
  "Hide account": "アカウントを隠す",
  "Refresh usage": "利用状況を更新",
  "Sign out": "サインアウト",
  "%s of this week's allowance used": "今週の利用枠を %s 使用",
  "%s of this month's allowance used": "今月の利用枠を %s 使用",
  "%s of the allowance used": "利用枠を %s 使用",
  "resets %s": "%s にリセット",
  "%s extra usage credits": "追加利用クレジット %s",
  "auto top-up %s of %s": "自動チャージ %s / %s",
  "Could not start the sign-in": "サインインを開始できませんでした",
  "Something went wrong": "問題が発生しました",
  "Approve the sign-in in your browser. If it asks for a code, enter": "ブラウザでサインインを承認してください。コードを求められたら次を入力：",
  "Waiting for approval…": "承認を待っています…",
  "Open the page again": "ページをもう一度開く",
  "Using your API key until you try again.": "再試行するまで API キーを使用します。",
  "Save an API key above to keep working until then.": "それまで使い続けるには、上に API キーを保存してください。",
  "Try again": "再試行",
  "Use a SuperGrok or X Premium subscription instead of paying per use: calls come out of its weekly allowance, which Grok chat shares. xAI decides which accounts and features it covers. While signed in it replaces the API key. If the allowance runs out or xAI refuses the subscription, calls switch to the API key (billed per use) when one is saved, until you press Try again. Custom voices from the xAI console only work on the API key, so sign out here to use them.":"従量課金の代わりに SuperGrok または X Premium のサブスクリプションを使います。利用分は Grok チャットと共有の週ごとの利用枠から差し引かれます。対象となるアカウントや機能は xAI が決めます。サインイン中は API キーの代わりに使われます。利用枠を使い切ったり xAI がサブスクリプションを拒否したりした場合は、API キーが保存されていれば「再試行」を押すまで API キー（従量課金）に切り替わります。xAI コンソールのカスタムボイスは API キーでのみ使えるため、使う場合はここでサインアウトしてください。",

  // ── Settings → Models & providers ─────────────────────────────────────
  "Models & providers": "モデルとプロバイダー",
  "Voice setups": "音声セットアップ",
  "Where your companions' AI runs. Built in is Grok Realtime: one xAI model that hears and speaks, on your xAI key. Add connections to other providers (OpenAI, Claude, ElevenLabs, Fish Audio) or to models on this computer, then build voice setups from them. A setup runs its calls on a speech-to-speech model (OpenAI Realtime), or as three engines you choose separately - speech to text, a text model as the brain, and a voice. Its brain can also run the companion's text chat, summaries and tasks. Each companion picks its setup (and its own voice) in the Companions tab; every call feature works on all of them.":
    "コンパニオンの AI をどこで動かすか。組み込みは Grok Realtime で、1 つの xAI モデルが聞き取りと発話を担います（xAI キーを使用）。ほかのプロバイダー（OpenAI、Claude、ElevenLabs、Fish Audio）やこのコンピューター上のモデルへの接続を追加し、それらから音声セットアップを作ります。セットアップは通話を音声対音声モデル（OpenAI Realtime）で動かすか、個別に選ぶ 3 つのエンジン（音声認識、頭脳となるテキストモデル、音声合成）で動かします。その頭脳は、コンパニオンのテキストチャット、要約、タスクも担えます。各コンパニオンはコンパニオンタブでセットアップ（と自分の声）を選びます。通話の機能はどれでもすべて使えます。",
  "Default for companions": "コンパニオンの既定",
  "Grok Realtime": "Grok リアルタイム",
  "Connections": "接続",
  "Where engines live: a server on this computer or a service, entered once and shared by every setup.":
    "エンジンの置き場所：このコンピューター上のサーバーやサービス。一度入力すれば、すべてのセットアップで共有されます。",
  "Built in - uses the xAI API key above.": "組み込み — 上の xAI API キーを使います。",
  "Other: %s": "その他：%s",
  "OpenAI-compatible server": "OpenAI 互換サーバー",
  "Built in - xAI's speech-to-speech voice model (Voice model above). The most natural timing; billed per connected minute (about $0.08).":
    "組み込み — xAI の音声対音声モデル（上の「音声モデル」）。最も自然な間合い。接続時間 1 分ごとの課金（約 $0.08）。",
  "Add voice setup": "音声セットアップを追加",
  "New voice setup": "新しい音声セットアップ",
  "xAI": "xAI",
  "Speech to text": "音声認識",
  "Brain": "頭脳",
  "%s decides where your turn ends itself.": "%s が発話の終わりを自分で判定します。",
  "Start replying early": "早めに返答を始める",
  "When your turn sounds finished, the brain starts on your live words while the final transcript is made, and the reply is dropped if the final words differ. Saves the transcriber's finishing time on each reply, for an occasional extra brain request. Needs live words (a streaming engine, or live words on). LiveKit Agents default: on.":
    "話し終えたと判断した時点で、最終的な文字起こしを待たずにライブの文字起こしで頭脳が返答を始めます。最終的な言葉が違えば、その返答は破棄されます。返答のたびに文字起こしの確定時間を節約できる代わりに、ときどき頭脳へのリクエストが一回増えます。ライブの文字起こし（ストリーミング対応エンジン、またはライブ表示をオン）が必要です。LiveKit Agents の既定値: オン。",
  "Smart Turn ends your turn as soon as you sound finished; %s's own end-of-turn detection is the backstop.":
    "言い終えたと Smart Turn が判断した時点でターンを終えます。%s 自身の発話終了判定は予備です。",
  "Turns end when the voice detector hears a pause and Smart Turn judges the thought finished.":
    "音声検出が間を聞き取り、Smart Turn が話し終えたと判断した時点で発話を区切ります。",
  "Turns end after a set silence (see Turn taking below).": "一定の無音で発話を区切ります（下の「ターンの取り方」を参照）。",
  "Web search, X search and MCP servers run at the brain's provider (xAI, OpenAI's own API or Anthropic), so companions don't have them with this brain.":
    "ウェブ検索・X 検索・MCP サーバーは頭脳のプロバイダー（xAI、OpenAI 本家の API、Anthropic）側で動くため、この頭脳ではコンパニオンは使えません。",
  "X search is Grok's own, so companions don't have it with this brain. Web search and MCP servers run at its provider.":
    "X 検索は Grok 専用のため、この頭脳ではコンパニオンは使えません。ウェブ検索と MCP サーバーはそのプロバイダー側で動きます。",
  "This voice doesn't render Grok speech tags ([laugh], <whisper>), so companions aren't taught them on calls or for voice messages. Whatever a companion writes is sent to the voice as written. If the model behind it has tags of its own, describe them in each companion's editor (Speech tags).":
    "この音声は Grok のスピーチタグ（[laugh]、<whisper>）を表現しないため、通話でもボイスメッセージでもコンパニオンにタグを教えません。コンパニオンが書いた内容は、そのまま音声に送られます。この音声のモデルに独自のタグがある場合は、各コンパニオンの編集画面（スピーチタグ）に書いてください。",
  "Offers speech to text": "音声認識に対応",
  "Offers a brain": "頭脳（チャットモデル）に対応",
  "Offers a voice": "音声合成に対応",
  "The server answers /v1/audio/transcriptions. Unticked, setups don't list it under Speech to text.":
    "このサーバーは /v1/audio/transcriptions に応答します。チェックを外すと、セットアップの「音声認識」の選択肢に出ません。",
  "The server answers /v1/chat/completions. Unticked, setups don't list it under Brain.":
    "このサーバーは /v1/chat/completions に応答します。チェックを外すと、セットアップの「頭脳」の選択肢に出ません。",
  "The server answers /v1/audio/speech. Unticked, setups don't list it under Voice.":
    "このサーバーは /v1/audio/speech に応答します。チェックを外すと、セットアップの「音声」の選択肢に出ません。",
  "xAI rates (check xAI pricing): streaming speech to text $0.20 an hour, voice $15 per million characters, grok-4.3 $1.25 / $2.50 per million tokens in / out ($0.20 cached in).":
    "xAI の料金（最新は xAI の料金表で確認）：ストリーミング音声認識 1 時間 $0.20、音声合成 100 万文字あたり $15、grok-4.3 は 100 万トークンあたり入力 $1.25 / 出力 $2.50（キャッシュ入力 $0.20）。",
  "Turn taking": "ターンの取り方",
  "Save your changes first - the test uses the saved settings.": "先に変更を保存してください。テストは保存済みの設定を使います。",
  "Runs each engine once: the brain answers, the voice speaks a line, and the transcriber hears it back.":
    "各エンジンを 1 回ずつ動かします。頭脳が返答し、音声がひと言話し、音声認識がそれを聞き取ります。",
  "The test failed.": "テストに失敗しました。",
  "first %s ms": "最初 %s ms",
  "done %s ms": "完了 %s ms",
  "voice: %s": "音声: %s",
  // Engine descriptions and fields (server/pipeline/*.py)
  "xAI (streaming)": "xAI（ストリーミング）",
  "Grok speech recognition over a live connection, with interim words and built-in end-of-turn detection. Uses your xAI key.":
    "常時接続の Grok 音声認識。話している途中の文字起こしと、発話終了の判定を内蔵。xAI キーを使用します。",
  "Model": "モデル",
  "Optional code (en, ja, ...) - turns on number and currency formatting for that language. Speech in any supported language is transcribed either way.":
    "任意のコード（en、ja など）。その言語の数字や通貨の表記整形が有効になります。対応言語ならどれでも、指定がなくても文字起こしされます。",
  "End-of-turn confidence": "発話終了の確信度",
  "xAI Smart Turn threshold (0-1): 0.5 balanced, 0.7 conservative, 0.9 very conservative (xAI docs). 0 turns it off and ends turns on silence alone.":
    "xAI Smart Turn のしきい値（0〜1）：0.5 標準、0.7 慎重、0.9 とても慎重（xAI ドキュメント）。0 で無効になり、無音だけで区切ります。",
  "Longest pause inside a turn (ms)": "発話中の最長の間（ms）",
  "The turn ends after this much silence even if Smart Turn thinks you are not done (1-5000). Pipecat uses 3000 ms.":
    "Smart Turn がまだ話し終えていないと判断しても、この長さの無音で区切ります（1〜5000）。Pipecat は 3000 ms。",
  "Silence before a turn can end (ms)": "区切るまでの無音（ms）",
  "xAI default: 400 ms.": "xAI の既定値：400 ms。",
  "OpenAI-compatible": "OpenAI 互換",
  "Local Whisper servers (speaches, faster-whisper-server), Groq or OpenAI: anything that serves /v1/audio/transcriptions.":
    "ローカルの Whisper サーバー（speaches、faster-whisper-server）、Groq、OpenAI など、/v1/audio/transcriptions に対応するもの。",
  "Server URL": "サーバー URL",
  "The URL that ends in /v1 - Ollama http://127.0.0.1:11434/v1, LM Studio http://127.0.0.1:1234/v1, speaches http://127.0.0.1:8000/v1, Kokoro-FastAPI http://127.0.0.1:8880/v1, OpenAI https://api.openai.com/v1.":
    "/v1 で終わる URL — Ollama http://127.0.0.1:11434/v1、LM Studio http://127.0.0.1:1234/v1、speaches http://127.0.0.1:8000/v1、Kokoro-FastAPI http://127.0.0.1:8880/v1、OpenAI https://api.openai.com/v1。",
  "Leave empty for a local server.": "ローカルサーバーなら空欄のままで構いません。",
  "As the server names it, e.g. whisper-large-v3-turbo on Groq, gpt-4o-mini-transcribe on OpenAI.":
    "サーバーでの名前のとおりに（例：Groq なら whisper-large-v3-turbo、OpenAI なら gpt-4o-mini-transcribe）。",
  "Optional ISO code (en, ja, ...). Leave empty to detect it.": "任意の ISO コード（en、ja など）。空欄なら自動判定します。",
  "Live words while you talk (ms, 0 = off)": "話している途中の文字起こし（ms、0 = オフ）",
  "Re-transcribes what you have said so far at this interval, for the features that follow your words as you speak. Fine on a local server; on a paid one every pass is another billed request.":
    "話している言葉を追う機能のために、ここまでの発話をこの間隔で文字起こしし直します。ローカルサーバーなら問題ありませんが、有料サービスでは 1 回ごとに課金されます。",
  "xAI Grok": "xAI Grok",
  "Grok text models through the Responses API. Uses your xAI key.": "Responses API 経由の Grok テキストモデル。xAI キーを使用します。",
  "Reasoning": "推論",
  "Thinking before speaking, for models that offer it. grok-4.3 needs None: it answers in about 0.8 s without it and about 4.5 s on its default, low (Artificial Analysis, time to first answer token).":
    "話す前に考えるかどうか（対応モデルのみ）。grok-4.3 では「なし」が必要です。推論なしで約 0.8 秒、既定の low では約 4.5 秒かかって答え始めます（Artificial Analysis、最初の回答トークンまで）。",
  "Model's default": "モデルの既定値",
  "None - fastest reply": "なし — 最速の返答",
  "Local models (Ollama, LM Studio, llama.cpp, vLLM), OpenAI, or any hosted API that speaks /v1/chat/completions.":
    "ローカルモデル（Ollama、LM Studio、llama.cpp、vLLM）、OpenAI、または /v1/chat/completions に対応するクラウド API。",
  "API": "API",
  "Automatic - Responses on OpenAI, Chat Completions elsewhere": "自動 — OpenAI では Responses、それ以外は Chat Completions",
  "Chat Completions (/chat/completions)": "Chat Completions（/chat/completions）",
  "Responses (/responses)": "Responses（/responses）",
  "OpenAI's Responses API runs web search, code interpreter and remote MCP servers for the companion, and reads attached PDFs and Office documents. Those work only on OpenAI's own API (api.openai.com); another server on Responses gets the app's own tools only.":
    "OpenAI の Responses API は、コンパニオンのためにウェブ検索・コードインタープリタ・リモート MCP サーバーを実行し、添付した PDF や Office 文書も読み取ります。これらは OpenAI 本家の API（api.openai.com）でのみ動き、Responses に対応する他のサーバーではアプリ自身のツールだけが使えます。",
  "Minimal": "最小",
  "Thinking before answering, for reasoning models (OpenAI's gpt-5 family and others). Not sent when left on the default; which values a model takes varies.":
    "推論モデル（OpenAI の gpt-5 系など）が答える前に考える量。既定値のままなら送信しません。使える値はモデルによって異なります。",
  "Anthropic (Claude)": "Anthropic（Claude）",
  "Claude models through Anthropic's Messages API, with prompt caching.":
    "Anthropic の Messages API 経由の Claude モデル（プロンプトキャッシュ付き）。",
  "Anthropic's API. Change it only for a proxy that speaks the Messages API.":
    "Anthropic の API。Messages API に対応するプロキシを使う場合だけ変更してください。",
  "A Claude API key, from platform.claude.com → API keys.": "Claude の API キー（platform.claude.com → API keys で発行）。",
  "e.g. claude-opus-5-5, claude-sonnet-5-5, or claude-haiku-4-5 for the quickest replies.":
    "例：claude-opus-5-5、claude-sonnet-5-5、最速の返答なら claude-haiku-4-5。",
  "OpenAI's API. Change it only for a proxy in front of it.":
    "OpenAI の API。前段にプロキシを置く場合だけ変更してください。",
  "An OpenAI API key, from platform.openai.com → API keys.": "OpenAI の API キー（platform.openai.com → API keys で発行）。",
  "OpenAI's models through the Responses API, with web search, code interpreter, remote MCP servers and prompt caching.":
    "Responses API 経由の OpenAI モデル（ウェブ検索、コードインタープリタ、リモート MCP サーバー、プロンプトキャッシュ付き）。",
  "gpt-6.1-sol (balanced), gpt-6-astra (most capable, 5x the price) or gpt-6-luna (fastest and cheapest).":
    "gpt-6.1-sol（バランス型）、gpt-6-astra（最も高性能、価格は 5 倍）、gpt-6-luna（最速・最安）。",
  "None - fastest (gpt-6-luna)": "なし — 最速（gpt-6-luna）",
  "Thinking before answering. Low suits conversation; gpt-6.1-sol and gpt-6-astra start at Low (a level a model doesn't take falls back to its default).":
    "答える前に考える量。会話には低が適しています。gpt-6.1-sol と gpt-6-astra は低から（モデルが受け付けないレベルはその既定値に戻ります）。",
  "OpenAI's current models all see images: ones you attach in chat reach it, and analyze_screen runs on it instead of Grok vision.":
    "OpenAI の現行モデルはすべて画像を認識できます。チャットで添付した画像が届き、analyze_screen も Grok の画像認識の代わりにこのモデルで動きます。",
  "Merged into every request, for Responses API options the app doesn't set.":
    "すべてのリクエストに追加される、アプリが設定しない Responses API のオプション。",
  "OpenAI's speech to text (gpt-transcribe, $0.0045 a minute). Uses your OpenAI API key.":
    "OpenAI の音声認識（gpt-transcribe、1 分 $0.0045）。OpenAI API キーを使用します。",
  "gpt-transcribe (OpenAI's recommended model), or whisper-1.": "gpt-transcribe（OpenAI の推奨モデル）または whisper-1。",
  "Re-transcribes what you have said so far at this interval, for the features that follow your words as you speak. Every pass is another billed request.":
    "話している言葉を追う機能のために、ここまでの発話をこの間隔で文字起こしし直します。1 回ごとに課金されます。",
  "OpenAI's voices (gpt-4o-mini-tts). Uses your OpenAI API key.": "OpenAI の声（gpt-4o-mini-tts）。OpenAI API キーを使用します。",
  "OpenAI voice (marin, cedar, coral, alloy...)": "OpenAI の声（marin、cedar、coral、alloy など）",
  "gpt-4o-mini-tts (newest), or tts-1 / tts-1-hd (fewer voices, no delivery prompt).":
    "gpt-4o-mini-tts（最新）、または tts-1 / tts-1-hd（声の数が少なく、話し方の指示は使えません）。",
  "Used for companions without a voice of their own for this setup. OpenAI recommends marin or cedar; the others are alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer and verse. Hear them at openai.fm.":
    "このセットアップで自分の声を持たないコンパニオンに使います。OpenAI のおすすめは marin か cedar。ほかに alloy、ash、ballad、coral、echo、fable、nova、onyx、sage、shimmer、verse があります。openai.fm で試聴できます。",
  "Delivery": "話し方",
  "How the voice speaks - accent, emotional range, tone, pace, whispering - for gpt-4o-mini-tts. Empty = the voice as it is.":
    "声の話し方（アクセント、感情の幅、トーン、速さ、ささやき）。gpt-4o-mini-tts 用。空欄なら声そのままです。",
  "Raw PCM (starts soonest)": "Raw PCM（最も早く始まる）",
  "WAV": "WAV",
  "OpenAI's raw PCM is 24 kHz 16-bit mono, and starts playing a little sooner.":
    "OpenAI の Raw PCM は 24 kHz・16 ビット・モノラルで、少し早く再生が始まります。",
  "24000 for OpenAI.": "OpenAI は 24000。",
  "OpenAI voice (marin, cedar, coral, alloy...)": "OpenAI の声（marin、cedar、coral、alloy など）",
  // Speech-to-speech setups (server/pipeline/realtime.py)
  "OpenAI Realtime": "OpenAI Realtime",
  "OpenAI's speech-to-speech models: one model hears you and answers in its own voice, billed per token. Web search and code run through delegate_task on this setup's brain.":
    "OpenAI の音声対音声モデル。1 つのモデルがあなたの声を聞き、自分の声で答えます（トークン課金）。Web 検索とコード実行は、このセットアップのブレインで delegate_task を通して行います。",
  "gpt-realtime-2.1 (best), gpt-realtime-2.1-mini (about a third of the price), or an older gpt-realtime-1.5 / gpt-realtime.":
    "gpt-realtime-2.1（最高品質）、gpt-realtime-2.1-mini（価格は約 3 分の 1）、または旧モデルの gpt-realtime-1.5 / gpt-realtime。",
  "marin and cedar are OpenAI's best voices; also alloy, ash, ballad, coral, echo, sage, shimmer, verse. Each companion can pick its own on the Companions tab.":
    "marin と cedar が OpenAI の最高品質の声です。ほかに alloy、ash、ballad、coral、echo、sage、shimmer、verse。コンパニオンごとに「コンパニオン」タブで選べます。",
  "Thinking before answering, on gpt-realtime-2 and later. Low suits conversation; more makes replies slower.":
    "答える前の思考（gpt-realtime-2 以降）。会話には「低」が合います。上げるほど返答が遅くなります。",
  "Transcription model": "文字起こしモデル",
  "Writes down what you say for the transcript and memories (billed separately, $0.0045/min). gpt-live-transcribe is the streaming one; the companion's key terms are passed to either.":
    "あなたの発言を書き起こし、トランスクリプトと記憶に使います（別料金、$0.0045/分）。gpt-live-transcribe はストリーミング版です。コンパニオンのキーワードはどちらにも渡されます。",
  "Turn detection": "ターン検出",
  "Silence - answers after a short pause": "無音 — 短い間のあとに答える",
  "Semantic - waits until you sound finished": "意味ベース — 話し終えたと判断するまで待つ",
  "Silence answers as soon as you pause, like Grok. Semantic turn detection reads whether you have finished your thought, so a pause mid-sentence doesn't cut you off, but it waits longer before each reply (see Semantic eagerness).":
    "無音検出は Grok と同じく、間が空くとすぐに答えます。意味ベースのターン検出は考えを言い終えたかを読み取るので文の途中の間で遮られませんが、毎回の返答までの待ち時間が長くなります（「意味ベースの積極さ」を参照）。",
  "OpenAI limits realtime tokens per minute by your account's usage tier: 40,000 on tier 1, about two replies a minute here (each resends the whole conversation, ~15-20k tokens); 200,000 on tier 2. Over it, a reply waits until the limit allows it.":
    "OpenAI はアカウントの利用ティアに応じて、リアルタイムモデルの 1 分あたりのトークン数を制限します。ティア 1 は 40,000（ここでは 1 分に約 2 回の返答。返答ごとに会話全体、約 1.5〜2 万トークンを再送します）、ティア 2 は 200,000。超えると、制限が許すまで返答を待ちます。",
  "OpenAI's per-minute token limit for your account was reached, so this reply waits %s s. Each reply resends the whole conversation; OpenAI raises the limit as your account's usage tier goes up.":
    "アカウントの OpenAI の 1 分あたりトークン上限に達したため、この返答は %s 秒待ちます。返答のたびに会話全体を再送します。上限はアカウントの利用ティアが上がると引き上げられます。",
  "Voice detection threshold": "音声検出のしきい値",
  "How loud speech must be to count as you talking (0-1), with Silence turn detection. Higher ignores more background noise and the companion's own echo; lower catches quieter speech. Grok uses 0.85, OpenAI's own default is 0.5.":
    "「無音」ターン検出で、あなたが話していると判断する音量（0〜1）。高いほど周囲の雑音やコンパニオン自身の声の反響を無視し、低いほど小さな声も拾います。Grok は 0.85、OpenAI の既定値は 0.5 です。",
  "Semantic eagerness": "意味ベースの積極さ",
  "High - waits up to 2 s": "高 — 最大 2 秒待つ",
  "Medium - up to 4 s": "中 — 最大 4 秒",
  "Low - up to 8 s, lets you take your time": "低 — 最大 8 秒、ゆっくり話せる",
  "Auto (= medium)": "自動（＝中）",
  "With semantic turn detection: the longest it waits after you stop before answering.":
    "意味ベースのターン検出で、話し終えてから答えるまでに待つ最長時間。",
  "Summarise at (tokens per reply)": "要約するサイズ（1 返答あたりのトークン数）",
  "When one reply's request reaches this size, the older part of the call is summarised and the call reconnects with the summary. Every reply resends the whole conversation, so this caps what each reply costs; the 2.x models take up to 128k.":
    "1 回の返答のリクエストがこのサイズに達すると、通話の古い部分を要約し、要約付きで通話を再接続します。返答のたびに会話全体が再送されるため、1 返答あたりの費用の上限になります。2.x モデルは最大 128k まで扱えます。",
  "Noise reduction": "ノイズ除去",
  "Off (the browser already filters)": "オフ（ブラウザーが既にフィルター済み）",
  "Headset / close mic": "ヘッドセット / 近接マイク",
  "Laptop / room mic": "ノート PC / 室内マイク",
  "Calls run on": "通話の実行方式",
  "A speech-to-speech model hears you and answers in its own voice, with the most natural timing. Separate stages let you mix providers and local models.":
    "音声対音声モデルはあなたの声を聞いて自分の声で答え、最も自然なタイミングで話します。個別ステージなら、プロバイダーやローカルモデルを組み合わせられます。",
  "Separate stages: speech to text → brain → voice": "個別ステージ：音声認識 → ブレイン → 声",
  "Speech-to-speech: %s Realtime": "音声対音声：%s Realtime",
  "Speech-to-speech": "音声対音声",
  "Brain for text chat, summaries and tasks": "テキストチャット・要約・タスク用のブレイン",
  "%s Realtime (%s) · text and tasks: %s": "%s Realtime（%s）· テキストとタスク：%s",
  "On calls, web search and code run through delegate_task on the brain above (when it is Claude or OpenAI's own API); MCP servers run at OpenAI during the call.":
    "通話中の Web 検索とコード実行は、上のブレイン（Claude または OpenAI 公式 API の場合）で delegate_task を通して行います。MCP サーバーは通話中に OpenAI 側で実行されます。",
  "OpenAI's voices don't render Grok speech tags ([laugh], <whisper>), so companions aren't taught them on calls. Voice messages use the voice above.":
    "OpenAI の声は Grok の音声タグ（[laugh]、<whisper>）を表現しないため、通話ではコンパニオンに教えません。ボイスメッセージは上の声を使います。",
  "Voice for voice messages": "ボイスメッセージ用の声",
  "OpenAI rates (check OpenAI pricing): gpt-realtime-2.1 audio $32 / $64 per million tokens in / out (about 10 tokens a second of your speech, 20 of theirs), gpt-realtime-2.1-mini $10 / $20. A call lasts up to 60 minutes, then reconnects.":
    "OpenAI の料金（OpenAI の価格表で確認してください）：gpt-realtime-2.1 の音声は入力 / 出力 100 万トークンあたり $32 / $64（あなたの発話は 1 秒約 10 トークン、相手は約 20 トークン）、gpt-realtime-2.1-mini は $10 / $20。1 回の通話は最長 60 分で、その後再接続します。",
  "The brain answers once, and OpenAI issues a call key for the speech-to-speech model (checks the key and model name).":
    "ブレインが 1 回答え、OpenAI が音声対音声モデル用の通話キーを発行します（キーとモデル名の確認）。",
  "Quick model": "クイックモデル",
  "For quick looks: analyze_screen reading your screen or camera, and delegate_task's quick checks. Empty = the main model.":
    "すばやい確認用：analyze_screen による画面やカメラの読み取りと、delegate_task のクイックチェック。空欄ならメインのモデルを使います。",
  "For quick looks: analyze_screen reading your screen or camera, and delegate_task's quick checks - a smaller, faster model on the same server. Empty = the main model.":
    "すばやい確認用：analyze_screen による画面やカメラの読み取りと、delegate_task のクイックチェック。同じサーバー上の小さく速いモデルを指定します。空欄ならメインのモデルを使います。",
  "Effort": "エフォート",
  "Low - quickest replies": "低 — 最速の返答",
  "Extra high": "最高",
  "Max": "最大",
  "How much Claude thinks before answering, and how many tokens it spends. Low suits conversation (Claude API guidance); current models think adaptively within it. Skipped for a model without the setting (Haiku 4.5).":
    "Claude が答える前にどれだけ考え、どれだけトークンを使うか。会話には低が適しています（Claude API のガイダンス）。現行モデルはその範囲で適応的に考えます。この設定のないモデル（Haiku 4.5）では送信しません。",
  "Can see images and PDFs": "画像と PDF を認識できる",
  "Images and PDFs you attach in chat reach Claude, and analyze_screen runs on it instead of Grok vision.":
    "チャットで添付した画像と PDF が Claude に届き、analyze_screen も Grok の画像認識の代わりに Claude で動きます。",
  "Merged into every request, for Messages API options the app doesn't set.":
    "すべてのリクエストに追加される、アプリが設定しない Messages API のオプション。",
  "Every tool description is read on every turn. Small local models answer faster, and stay in character better, without them.":
    "ツールの説明は毎ターンすべて読み込まれます。小さなローカルモデルは、ツールなしの方が速く答え、キャラクターも崩れにくくなります。",
  "All of the companion's tools": "コンパニオンのツールすべて",
  "No tools - talk only": "ツールなし — 会話のみ",
  "Extra request fields (JSON)": "追加のリクエスト項目（JSON）",
  "Merged into every request, for server-specific options, e.g. {\"options\": {\"num_ctx\": 16384}} for Ollama.":
    "すべてのリクエストに追加される、サーバー固有のオプション。例：Ollama なら {\"options\": {\"num_ctx\": 16384}}。",
  "The same Grok voices as realtime calls, speech tags included. Uses your xAI key.":
    "リアルタイム通話と同じ Grok の声（スピーチタグ対応）。xAI キーを使用します。",
  "Default voice": "既定の声",
  "Leave empty to use each companion's own Grok voice.": "空欄なら各コンパニオン自身の Grok の声を使います。",
  "Grok voice (leave empty for the companion's own)": "Grok の声（空欄ならコンパニオン自身の声）",
  "Voice name on the server (e.g. af_heart on Kokoro)": "サーバー上の声の名前（例：Kokoro なら af_heart）",
  "Fish Audio voice id (reference id)": "Fish Audio の voice id（reference id）",
  "Latency": "レイテンシ",
  "xAI optimize_streaming_latency: smaller first chunks start sooner, with a small quality cost at chunk boundaries.":
    "xAI の optimize_streaming_latency：最初の区切りを小さくして早く話し始めます。区切り目の音質がわずかに下がります。",
  "Best quality": "最高品質",
  "Faster first words": "話し始めを速く",
  "Fastest first words": "話し始めを最速に",
  "Local voices (Kokoro-FastAPI, Irodori-TTS-Server, speaches) or any API that serves /v1/audio/speech.":
    "ローカルの音声（Kokoro-FastAPI、Irodori-TTS-Server、speaches）や、/v1/audio/speech に対応する API。",
  "Used for companions without a voice of their own for this setup. af_heart is Kokoro's default voice.":
    "このセットアップ用の声を設定していないコンパニオンに使います。af_heart は Kokoro の既定の声です。",
  "Audio format": "音声フォーマット",
  "WAV describes its own sample rate. Raw PCM starts a little sooner, but needs the rate below.":
    "WAV はサンプルレートを自ら示します。Raw PCM は少し早く始まりますが、下のレートの指定が必要です。",
  "WAV (any sample rate)": "WAV（任意のサンプルレート）",
  "Raw PCM": "Raw PCM",
  "PCM sample rate": "PCM サンプルレート",
  "Only for raw PCM: 24000 for OpenAI and Kokoro.": "Raw PCM のみ：OpenAI と Kokoro は 24000。",
  "Merged into every request - e.g. {\"instructions\": \"...\"} for gpt-4o-mini-tts, or an \"irodori\" options object.":
    "すべてのリクエストに追加されます。例：gpt-4o-mini-tts なら {\"instructions\": \"...\"}、または \"irodori\" のオプション。",
  "Fish Audio": "Fish Audio",
  "Fish Audio voices and voice clones (fish.audio API key).": "Fish Audio の声とボイスクローン（fish.audio の API キー）。",
  "ElevenLabs voices and voice clones (elevenlabs.io API key).": "ElevenLabs の声とボイスクローン（elevenlabs.io の API キー）。",
  "ElevenLabs voice id": "ElevenLabs の音声 ID",
  "From elevenlabs.io → Developers → API keys.": "elevenlabs.io → Developers → API keys から取得します。",
  "eleven_v4 (best quality, audio tags; $0.08 per 1,000 characters), eleven_flash_v2_5 (fastest, ~75 ms, no tags, $0.04), eleven_v3, or eleven_multilingual_v2.":
    "eleven_v4（最高品質、オーディオタグ対応、1,000 文字あたり $0.08）、eleven_flash_v2_5（最速、約 75 ms、タグなし、$0.04）、eleven_v3、または eleven_multilingual_v2。",
  "Default voice (voice id)": "既定の声（音声 ID）",
  "Used for companions without a voice of their own for this setup: the voice id from your ElevenLabs Voices page (a voice's name doesn't work). ElevenLabs' old premade voices are being retired, so pick one of yours or from their library.":
    "このセットアップで自分の声を持たないコンパニオンに使います。ElevenLabs の Voices ページにある音声 ID（声の名前では動きません）。ElevenLabs の旧プリセット音声は廃止予定のため、自分の声かライブラリの声を選んでください。",
  "Stability": "安定性",
  "0-1. Lower is more expressive and varied, higher more even. ElevenLabs default: 0.5.":
    "0〜1。低いほど表情豊かで変化があり、高いほど均一です。ElevenLabs の既定値は 0.5。",
  "Similarity": "類似度",
  "0-1. How closely it holds to the original voice. ElevenLabs default: 0.75.":
    "0〜1。元の声にどれだけ近づけるか。ElevenLabs の既定値は 0.75。",
  "s2.1-pro (Fish's default), s2-pro, s1, or s2.1-pro-free.": "s2.1-pro（Fish の既定）、s2-pro、s1、または s2.1-pro-free。",
  "Default voice (reference id)": "既定の声（reference id）",
  "Used for companions without a voice of their own for this setup.": "このセットアップ用の声を設定していないコンパニオンに使います。",
  "Used for companions without a voice of their own for this setup. The id from the voice's page on fish.audio (32 letters and digits); a voice's name doesn't work.":
    "このセットアップ用の声を設定していないコンパニオンに使います。fish.audio の声のページにある id（英数字 32 文字）を入れてください。声の名前では動きません。",
  "Lowest latency": "最低レイテンシ",
  "Smart Turn (local)": "Smart Turn（ローカル）",
  "Listens to how you speak, not just for silence, to tell a finished thought from a pause mid-sentence (Pipecat Smart Turn v3.2, runs on this computer). With a live transcription engine it ends your turn early, as soon as you sound finished; the engine's own detection stays as the backstop.":
    "無音だけでなく話し方を聞いて、言い終えたのか文の途中の間なのかを見分けます（Pipecat Smart Turn v3.2、このコンピューター上で動作）。ライブ音声認識エンジンでは、言い終えたと判断した時点で早めにターンを終えます。エンジン自身の判定は予備として残ります。",
  "Speech threshold": "発話のしきい値",
  "How sure the voice detector must be that a sound is speech (0-1). Raise it if background noise or the companion's own voice through your speakers keeps interrupting. Pipecat default: 0.7.":
    "音を発話とみなすのに音声検出が必要とする確信度（0〜1）。周囲の雑音やスピーカーから出るコンパニオン自身の声で割り込まれる場合は上げてください。Pipecat の既定値：0.7。",
  "Silence that ends a turn without Smart Turn (ms)": "Smart Turn なしで区切る無音（ms）",
  "Pipecat's voice-detector stop time before it had a turn model: 800 ms.": "ターン判定モデル導入前の Pipecat の音声検出の停止時間：800 ms。",
  "With Smart Turn on, a turn it judges unfinished still ends after this much silence. Pipecat default: 3000 ms.":
    "Smart Turn がオンのとき、話し終えていないと判断した発話もこの無音で区切ります。Pipecat の既定値：3000 ms。",
  "Speech needed to interrupt (ms)": "割り込みに必要な発話（ms）",
  "While the companion is talking, you must speak this long to cut in, so a cough or a \"mm\" doesn't stop them. LiveKit Agents default: 500 ms.":
    "コンパニオンが話している間は、この長さ話すと割り込めます。咳や「うん」で止まらないためです。LiveKit Agents の既定値：500 ms。",
  // Credits
  "Voice pipeline": "音声パイプライン",
  "MIT, Silero Team. The bundled voice detector that hears when you start and stop speaking.":
    "MIT、Silero Team。話し始めと話し終わりを聞き取る、同梱の音声検出。",
  "BSD 2-Clause, Daily. The bundled model that tells a finished thought from a pause; its audio features are ported from Pipecat (portions Apache-2.0, Hugging Face Transformers).":
    "BSD 2-Clause、Daily。言い終えたのか間なのかを見分ける同梱のモデル。音声特徴量のコードは Pipecat から移植（一部 Apache-2.0、Hugging Face Transformers）。",
  // Companion editor
  "How this companion's voice calls run: Grok Realtime, or one of the voice setups from Settings → Models & providers (a speech-to-speech model, or speech to text, brain and voice as separate engines).":
    "このコンパニオンの音声通話の方式：Grok リアルタイム、または 設定 → モデルとプロバイダー の音声セットアップのいずれか（音声対音声モデル、または音声認識・頭脳・音声合成を別々のエンジンで）。",
  "Voice setup": "音声セットアップ",
  "App default (%s)": "アプリの既定（%s）",
  "This companion's voice on this setup's voice server. Kept per server, so switching setups never sends it to a different engine. Leave empty for the setup's default voice.":
    "このセットアップの音声サーバーでのこのコンパニオンの声。サーバーごとに保存されるため、セットアップを切り替えても別のエンジンに送られることはありません。空欄ならセットアップの既定の声。",
  "Text chat runs on the app's Grok text model (Settings → Text model), or on the brain of this companion's voice setup - a local model, OpenAI or Claude, say. Web search and MCP servers need a brain whose provider runs them; X search is Grok's own.":
    "テキストチャットは、アプリの Grok テキストモデル（設定 → テキストモデル）か、このコンパニオンの音声セットアップの頭脳（ローカルモデル、OpenAI、Claude など）で動きます。ウェブ検索と MCP サーバーはそれらを実行するプロバイダーの頭脳が必要で、X 検索は Grok 専用です。",
  "Text chat brain": "テキストチャットの頭脳",
  "Grok (Settings → Text model)": "Grok（設定 → テキストモデル）",
  "The voice setup's brain (needs a voice setup)": "音声セットアップの頭脳（音声セットアップが必要）",
  "The voice setup's brain: %s": "音声セットアップの頭脳：%s",

  "Text model": "テキストモデル",
  "Summary model": "要約モデル",
  "Imagine model": "Imagine モデル",
  "Imagine video model": "Imagine 動画モデル",
  "Grok Imagine video model used for animated backgrounds and the create_video tool.":
    "アニメーション背景と create_video ツールで使用される Grok Imagine 動画モデル。",
  "Animated background": "アニメーション背景",
  "Attach images": "画像を添付",
  "Image upload failed: %s": "画像のアップロードに失敗しました: %s",
  // Settings: local generation (ComfyUI)
  "Local generation (ComfyUI)": "ローカル生成（ComfyUI）",
  "Render the companions' image and video tools on your own ComfyUI server instead of Grok Imagine: any model ComfyUI runs, no per-generation billing. A companion's \"Image & video tools\" toggle still decides whether the tools are offered at all; this only picks the engine behind each tool.":
    "コンパニオンの画像・動画ツールを Grok Imagine の代わりに自分の ComfyUI サーバーで実行します。ComfyUI で動くモデルなら何でも使え、生成ごとの課金もありません。ツール自体を提供するかどうかはコンパニオンの「画像・動画ツール」トグルが決め、ここでは各ツールのエンジンだけを選びます。",
  "ComfyUI URL": "ComfyUI の URL",
  "Auth header (optional)": "認証ヘッダー（任意）",
  "Sent on every request. For a rented pod behind a proxy password or a hosted service's API key. Leave empty for a plain local ComfyUI.":
    "すべてのリクエストに付加されます。プロキシパスワード付きのレンタル Pod やホスト型サービスの API キー用です。通常のローカル ComfyUI では空欄のままにしてください。",
  "Test connection": "接続テスト",
  "Connection failed": "接続に失敗しました",
  "free": "空き",
  "no GPU reported": "GPU が報告されていません",
  "Rexclaw in Docker or WSL while ComfyUI runs on Windows? Start ComfyUI with --listen and use that machine's address (from Docker: http://host.docker.internal:8188).":
    "Rexclaw を Docker や WSL で、ComfyUI を Windows で動かしている場合は、ComfyUI を --listen 付きで起動し、そのマシンのアドレスを指定してください（Docker からは http://host.docker.internal:8188）。",
  "Images": "画像",
  "Videos": "動画",
  "Backgrounds (voice calls)": "背景（音声通話）",
  "Grok Imagine (xAI)": "Grok Imagine（xAI）",
  "Local (ComfyUI)": "ローカル（ComfyUI）",
  "Workflows": "ワークフロー",
  "In ComfyUI, load a template for the model you want (Qwen Image Edit for image edits, Wan 2.2 image-to-video for clips, …), run it once so its models download, then Workflow → Export (API) and load that file here. Nothing needs renaming: the prompt, LoadImage, seed, size and length inputs are detected. Put {prompt} inside the positive prompt text to keep the rest as a fixed style prefix.":
    "ComfyUI で使いたいモデルのテンプレート（画像編集なら Qwen Image Edit、クリップなら Wan 2.2 image-to-video など）を読み込み、モデルをダウンロードするために一度実行してから、Workflow → Export (API) で書き出したファイルをここに読み込みます。名前の変更は不要です：プロンプト、LoadImage、シード、サイズ、長さの入力は自動検出されます。ポジティブプロンプトの中に {prompt} と書くと、残りの部分が固定のスタイル接頭辞として保持されます。",
  "Text to image": "テキストから画像",
  "Image edit (references)": "画像編集（参照画像）",
  "Text to video": "テキストから動画",
  "Image to video": "画像から動画",
  "create_image from a prompt alone, and still backgrounds.": "プロンプトのみからの create_image と静止背景。",
  "create_image featuring you, other companions, your photo or library images. Needs LoadImage node(s).": "あなた自身、他のコンパニオン、あなたの写真やライブラリ画像を使う create_image。LoadImage ノードが必要です。",
  "create_video from a prompt alone, and animated backgrounds.": "プロンプトのみからの create_video とアニメーション背景。",
  "create_video from a source image or featuring you: the frame the clip starts from.": "ソース画像またはあなた自身から始まる create_video。クリップの最初のフレームになります。",
  "prompt": "プロンプト",
  "no prompt node": "プロンプトノードなし",
  "not set": "未設定",
  "loaded": "読み込み済み",
  "Load JSON": "JSON を読み込む",
  "That file is not a ComfyUI API-format workflow.": "そのファイルは ComfyUI の API 形式ワークフローではありません。",
  "Could not read that workflow.": "そのワークフローを読み込めませんでした。",
  "Turn director model": "ターンディレクターモデル",
  "Model for the group-call turn director (a one-token \"who speaks next\" classification on every group-call turn). Latency matters more than intelligence here — use the fastest non-reasoning model available. Empty = fall back to the Text Model.":
    "グループ通話のターンディレクター用モデル（毎ターン「次は誰が話すか」を 1 トークンで判定）。知能より低遅延が重要 — 利用可能な最速の非推論モデルを指定してください。空欄の場合はテキストモデルにフォールバックします。",

  // ── Settings: you ─────────────────────────────────────────────────────
  "You": "あなた",
  "Display name (optional)": "表示名（任意）",
  "Default companion": "デフォルトのコンパニオン",
  "Language": "言語",
  "UI language — stored in this browser. Companions follow the language you speak regardless.":
    "UI の言語 — このブラウザに保存されます。コンパニオンは設定に関わらず、あなたが話す言語に合わせます。",
  "Include my name in the system prompt": "システムプロンプトに自分の名前を含める",
  "Your photo (optional)": "あなたの写真（任意）",
  "If set, any companion with Grok Imagine enabled can feature you in a generated image or video, using this photo as reference. Only upload one you're comfortable being used that way.":
    "設定すると、Grok Imagine が有効なコンパニオンは誰でも、この写真を参照としてあなたを生成画像・動画に登場させられるようになります。この用途で使われても構わないと思える写真だけをアップロードしてください。",
  "Your photo": "あなたの写真",
  "Could not remove photo": "写真を削除できませんでした",

  // ── Settings: context management ──────────────────────────────────────
  "Conversation length": "会話の長さ",
  "The thresholds and word limits here are for Grok Realtime calls and Grok text chat. A voice setup sets its own on its brain (Models & providers above), for the calls and text chat that run on it.":
    "ここでのしきい値と語数の上限は、Grok Realtime の通話と Grok のテキストチャット用です。音声セットアップは、その頭脳の設定（上の モデルとプロバイダー）で独自に決め、それで動く通話とテキストチャットに使われます。",
  "Grok Realtime calls: summarise after (tokens)": "Grok Realtime の通話：要約するまで（トークン）",
  "Grok text chat: summarise after (tokens)": "Grok のテキストチャット：要約するまで（トークン）",
  "Recent turns kept verbatim": "そのまま残す直近ターン数",
  "Summary word limit (low)": "要約の語数（下限）",
  "When a summary passes the high limit, it is rewritten down to about this many words, relationship milestones first. 0 = off (summaries keep growing).":
    "要約が上限を超えたら、関係の節目を優先してこの語数程度まで書き直します。0 = オフ（要約は増え続けます）。",
  "Summary word limit (high)": "要約の語数（上限）",
  "Below this, new conversation is added to the summary and older text is left as it is. Above it, the summary is rewritten down to the low limit.":
    "この語数までは新しい会話を要約に追記し、既存の文章はそのまま残します。超えたら下限まで書き直します。",
  "A companion can only hold so much of a conversation in mind at once, so long ones are condensed as they go. Once a conversation has exceeded summarization threshold tokens since its last summary, the older part is boiled down into a short recap and carried forward in its place, while the most recent turns are kept word for word. Your companion keeps the gist of everything that came before, and the immediate thread stays sharp. Mid-call this happens during a natural pause, so it never interrupts you. Long-term memory and the full transcript stay accessible either way — condensed conversations are stored as episodes your companion can look up again with its recall tool.":
    "コンパニオンが一度に把握できる会話量には限りがあるため、長い会話は進行に合わせて圧縮されます。前回の要約以降、会話が要約しきい値のトークン数を超えると、古い部分は短い要約にまとめられてその代わりに引き継がれ、直近のやり取りはそのままの言葉で保持されます。これにより、コンパニオンはそれまでの流れの要点を保ちつつ、目の前の話題を鮮明に把握できます。通話中は会話の自然な区切りで実行されるため、話の邪魔になることはありません。長期記憶と全文の記録はいずれの場合もアクセス可能です — 圧縮された会話はエピソードとして保存され、コンパニオンは recall ツールで再び参照できます。",
  "How many of the newest messages are left out of the recap and carried forward word for word.":
    "要約に含めず、そのままの言葉で引き継ぐ直近メッセージの件数です。",
  "Transcript messages shown on resume": "再開時に表示するメッセージ数",
  "Most-recent messages loaded into the transcript when a conversation is resumed; 0 shows everything. Older messages stay stored — this only affects what is painted on screen, not what the companion remembers.":
    "会話を再開したときにトランスクリプトへ読み込む直近メッセージの件数です。0 ですべて表示します。古いメッセージも保存されたままで、画面に描画される範囲だけが変わり、コンパニオンの記憶には影響しません。",

  // ── Settings: cost optimization ───────────────────────────────────────
  "Grok Realtime calls": "Grok Realtime の通話",
  "xAI bills a Realtime call for every connected minute and for each message replayed when a conversation is resumed. These keep that down; calls on a voice setup don't need them.":
    "xAI は Realtime の通話を、接続している 1 分ごとと、会話を再開したときに送り直すメッセージ 1 件ごとに課金します。これらはその費用を抑える設定で、音声セットアップでの通話には不要です。",
  "Resuming a voice conversation sends its history back to xAI one message at a time, at about $0.004 per message, so a 250-message backlog costs about $1 on every resume. With the roll-up on, the older messages are bundled into a single message, which cuts that to a few cents. Every word is still sent, but the bundled part arrives as one transcript, so your companion may recall it a little less sharply than the recent turns kept whole. Most useful if you resume often for short exchanges. Note: every summarization trims the message backlog, so a resume costs the most just before one is due.":
    "音声での会話を再開すると、履歴がメッセージ 1 件ずつ xAI に送り直され、1 件あたり約 $0.004 かかります。そのため、250 メッセージ分がたまっていると、再開のたびに約 $1 かかります。履歴のまとめをオンにすると、古いメッセージが 1 件にまとめられ、これが数セントになります。すべての語句はそのまま送信されますが、まとめられた部分は 1 つの記録として届くため、そのまま残す直近のターンに比べて、コンパニオンの記憶がやや曖昧になる可能性があります。短いやり取りのために頻繁に再開する場合に特に役立ちます。注：要約が行われるたびにたまったメッセージは減るため、再開のコストが最も高くなるのは次の要約の直前です。",
  "Roll up older history when resuming a conversation":
    "会話の再開時に古い履歴をまとめる",
  "Recent turns kept whole": "そのまま残す直近ターン数",
  "How many of the most recent messages stay as separate turns, exactly as they are sent today. Everything older is bundled. Higher keeps more of the conversation's natural shape and costs a little more; 0 bundles everything.":
    "直近の何件のメッセージを、現在と同じように個別のやり取りとして送信するかを指定します。それより古いものはまとめられます。大きくすると会話の自然な形がより多く保たれますが、コストはわずかに増えます。0 にするとすべてまとめられます。",
  "xAI drops an idle call at 15 minutes regardless. 0 turns this off. Calls on a voice setup stay connected - they cost little or nothing while quiet.":
    "xAI は、無操作の通話を 15 分で必ず切断します。0 で無効になります。音声セットアップでの通話は接続したままです。静かな間の費用はほとんど、またはまったくかかりません。",
  "End the call after this many idle minutes": "この分数だけ何も起きなければ通話を終了",

  // ── Settings: hotkeys ─────────────────────────────────────────────────
  "Hotkeys": "ホットキー",
  "Click a shortcut to record a new one, then press the keys you want. Backspace clears it, Escape keeps what was there. Shortcuts apply once you save.":
    "ショートカットをクリックしてから使いたいキーを押すと登録されます。Backspace で解除、Escape で変更を取り消します。ショートカットは保存すると有効になります。",
  "Use these shortcuts system-wide (desktop app)":
    "これらのショートカットをシステム全体で使う（デスクトップアプリ）",
  "The shortcuts work while you are in another application, but those key combinations stop reaching other programs while Rexclaw runs. With system-wide shortcuts off, they only work while a Rexclaw window has focus. If typing breaks elsewhere (Ctrl+Alt types AltGr characters on some keyboards), pick different keys.":
    "ショートカットは他のアプリを使っている間も動作しますが、Rexclaw の起動中はそのキーの組み合わせが他のプログラムに届かなくなります。システム全体のショートカットをオフにすると、Rexclaw のウィンドウにフォーカスがあるときだけ動作します。他のアプリで入力がおかしくなる場合（一部のキーボードでは Ctrl+Alt が AltGr の入力に使われます）は、別のキーを選んでください。",
  "Another application already owns these shortcuts, so they do nothing here: %s":
    "これらのショートカットは他のアプリケーションがすでに使用しているため、ここでは動作しません：%s",
  "This is a browser tab, so shortcuts only work while it has focus, and the avatar-window ones do nothing — they need the desktop app.":
    "これはブラウザのタブのため、ショートカットはこのタブにフォーカスがあるときのみ動作し、アバターウィンドウ関連の項目は動作しません（デスクトップアプリが必要です）。",
  "Call": "通話",
  "Desktop avatar": "デスクトップアバター",
  "App window": "アプリウィンドウ",
  "desktop app": "デスクトップアプリ",
  "Press keys…": "キーを押してください…",
  "Not set": "未設定",
  "Click, then press the keys to use": "クリックしてから使いたいキーを押します",
  "Back to the default (%s)": "デフォルトに戻す（%s）",
  "Restore default shortcuts": "ショートカットを既定値に戻す",
  "Another action uses this shortcut — only one of them will run.":
    "このショートカットは他の操作でも使われています — 実行されるのは一方だけです。",
  "Without a modifier key this swallows the key in every other application.":
    "修飾キーがないと、他のすべてのアプリケーションでこのキーが使えなくなります。",
  "Resume the last call / end the call": "前回の通話を再開／通話を終了",
  "No call: picks the conversation back up where it left off (or starts fresh when there is nothing to resume). In a call: ends it.":
    "通話していないとき：前回の続きから会話を再開します（再開できる会話がなければ新しく開始）。通話中：通話を終了します。",
  "Start a new conversation / end the call": "新しい会話を開始／通話を終了",
  "No call: begins from scratch, without resuming (and without replaying history to xAI). In a call: ends it.":
    "通話していないとき：常に最初から始めます（再開せず、履歴を xAI に再送もしません）。通話中：通話を終了します。",
  "Mute / unmute the microphone": "マイクのミュート切り替え",
  "Muting does not reduce what xAI charges — a connected call bills by the minute either way.":
    "ミュートしても xAI の料金は下がりません — 接続中の通話はいずれにせよ分単位で課金されます。",
  "Start / stop screen sharing": "画面共有の開始／停止",
  "Picking a screen needs a click, so the first use opens the picker rather than sharing outright.":
    "画面の選択にはクリックが必要なため、最初は共有ではなく選択画面が開きます。",
  "Pop the avatar out / back in": "アバターをポップアウト／戻す",
  "Open the mascot settings window": "マスコット設定ウィンドウを開く",
  "Works with the controls hidden too — the same window as the island's ⚙ and the tray entry.":
    "コントロールを隠していても使えます — アイランドの ⚙ やトレイの項目と同じウィンドウです。",
  "The same handoff as the pop-out button: a live call is ended and resumed in the other window.":
    "ポップアウトボタンと同じ引き継ぎです。通話中の場合はいったん終了し、もう一方のウィンドウで再開します。",
  "Ghost mode (clicks pass through)": "ゴーストモード（クリックが背面に通る）",
  "Show / hide the avatar controls": "アバターの操作パネルを表示／非表示",
  "Cycle the window size": "ウィンドウサイズを切り替え",
  "Movement mode": "移動モード",
  "Chat preferences": "チャットの設定",
  "Clear (back to default)": "クリア（既定に戻す）",
  "Discard": "破棄",
  "Could not render the avatar.": "アバターを描画できませんでした。",
  "Portrait generation failed": "ポートレートの生成に失敗しました",
  "Portrait — generated here, or the thumbnail embedded in the main VRM. Updates when the VRM changes (after Save).":
    "ポートレート — ここで生成するか、メイン VRM に埋め込まれたサムネイルを使います。VRM を変更すると（保存後に）更新されます。",
  "Render the avatar and save the shot beside the VRM (the VRM file itself is not modified). Face portraits are used in lists; full-body ones show the outfit and are what the companion uses for pictures of themselves in text chat.":
    "アバターを描画して VRM の隣にショットを保存します（VRM ファイル自体は変更されません）。顔のポートレートは一覧で使われ、全身のものは衣装が写り、テキストチャットでコンパニオンが自分の写真として使います。",
  "Render this outfit and save the shot beside its VRM (the VRM file itself is not modified).":
    "この衣装を描画して VRM の隣にショットを保存します（VRM ファイル自体は変更されません）。",
  "On voice calls the companion opens the conversation as soon as the call connects, instead of waiting for you to speak. Off by default - every call then starts with a turn from them.":
    "音声通話では、あなたが話すのを待たずに、接続と同時にコンパニオンが会話を切り出します。既定ではオフ — オンにすると毎回の通話が相手のターンから始まります。",
  "Only score changes of at least this size play the effect — small routine nudges stay invisible, so the hearts keep meaning something. Default 5 (the normal per-call maximum).":
    "この大きさ以上のスコア変化のときだけエフェクトを再生します — 小さな日常的な増減は表示されないので、ハートの意味が保たれます。既定は 5（通常の 1 通話あたりの最大値）。",
  "Whole screen (this display, taskbar excluded)": "画面全体（このディスプレイ、タスクバーを除く）",
  "Full": "全画面",
  "Face view / full body": "顔ビュー／全身ビュー",
  "Move to the top-left corner": "左上に移動",
  "Move to the top-right corner": "右上に移動",
  "Move to the bottom-left corner": "左下に移動",
  "Move to the bottom-right corner": "右下に移動",
  "Move to the next monitor": "次のモニターに移動",
  "Keeps the corner it is parked in; cycles back to the first monitor after the last.":
    "置かれている位置（隅）は保たれます。最後のモニターの次は最初に戻ります。",
  "Immersive view (hide all UI)": "没入ビュー（UI をすべて隠す）",
  "H on its own does the same thing while the Voice tab has focus.":
    "ボイスタブにフォーカスがあるときは H だけでも同じ操作ができます。",
  "Open the transcript window": "トランスクリプトウィンドウを開く",

  // ── Settings: voice activation (wake phrases) ─────────────────────────
  "Voice activation": "音声起動",
  "Say a companion's wake phrase, such as \"hey Eve\", to start a call hands-free. Set the phrase per companion on the Companions tab. Listening runs entirely on this machine. The microphone stays on while it listens, so your system will show its mic indicator.":
    "「ヘイ、イヴ」のようなコンパニオンのウェイクフレーズを言うと、ハンズフリーで通話を開始できます。フレーズは Companions タブでコンパニオンごとに設定します。聞き取りはすべてこのマシン上で行われます。聞き取り中はマイクがオンのままになるため、OS のマイクインジケーターが表示されます。",
  "Standby listening for wake phrases": "ウェイクフレーズのスタンバイリスニング",
  "Wake phrase language": "ウェイクフレーズの言語",
  "Language of the offline model that spots the phrases — pick the language you'll SAY them in. Changing it downloads that language's model (~40-50 MB, one-time).":
    "フレーズを検出するオフラインモデルの言語です — フレーズを「話す」言語を選んでください。変更するとその言語のモデル（約 40〜50 MB、一度だけ）がダウンロードされます。",
  "Status": "状態",
  "Not listening": "リスニングしていません",
  "Listening in another window": "別のウィンドウでリスニング中",
  "Starting…": "開始しています…",
  "Downloading speech model… %s%%": "音声モデルをダウンロード中… %s%%",
  "Loading speech model…": "音声モデルを読み込み中…",
  "Listening for wake phrases": "ウェイクフレーズを待機中",
  "Applies when you save. Companions without a wake phrase are simply not listened for.":
    "保存すると適用されます。ウェイクフレーズのないコンパニオンは単に検出対象になりません。",
  "Wake phrase (voice activation)": "ウェイクフレーズ（音声起動）",
  "With standby listening enabled (Settings → Voice activation), saying this phrase while no call is live starts one with this companion. Keep it 2-4 words and distinctive — e.g. 'hey Eve'. Leave empty to opt this companion out.":
    "スタンバイリスニングが有効なとき（設定 → 音声起動）、通話していない間にこのフレーズを言うと、このコンパニオンとの通話が始まります。2〜4 語の特徴的なフレーズにしてください — 例：「ヘイ、イヴ」。空にするとこのコンパニオンは対象外になります。",
  "e.g. 'hey %s'": "例：「ヘイ、%s」",
  "On wake phrase": "ウェイクフレーズを聞いたとき",
  "Resume the last conversation": "前回の会話を再開",
  "Start a new conversation": "新しい会話を開始",
  "Time-aware resume (note how long it has been)": "時間を意識した再開（経過時間をメモ）",
  "When you resume a conversation, a dated note tells the companion when the two of you last spoke and how long ago that was, so it can pick up naturally after hours or days instead of mid-sentence. The note is visible in the transcript, which is why this is off by default.": "会話を再開すると、最後に話した日時とその経過時間を記した日付入りのメモがコンパニオンに渡され、数時間や数日の空白の後でも途中からではなく自然に再開できます。メモはトランスクリプトに表示されるため、既定ではオフです。",
  "End-call tool (hang up on request)": "通話終了ツール（頼まれたら切る）",

  // ── Settings: desktop app ─────────────────────────────────────────────
  "Desktop app": "デスクトップアプリ",
  "Launch Rexclaw when you sign in to your computer": "パソコンにサインインしたとき Rexclaw を起動する",
  "Starts Rexclaw by itself each time you sign in. Pair it with mascot mode below to have your companion waiting on the desktop.":
    "サインインするたびに Rexclaw が自動で起動します。下のマスコットモードと組み合わせると、コンパニオンがデスクトップで待っていてくれます。",
  "Mascot mode opens Rexclaw as the pop-out avatar on your desktop instead of the app window. Pop back in from the avatar's controls or the tray icon. Applies from the next launch.":
    "マスコットモードでは、Rexclaw がアプリウィンドウではなく、デスクトップ上のポップアウトしたアバターとして起動します。アバターの操作パネルかトレイアイコンから通常のウィンドウに戻せます。次回の起動から反映されます。",
  "Open in mascot mode": "マスコットモードで起動する",
  "Hide the avatar between calls": "通話していない間はアバターを隠す",
  "The avatar hides while no call is live and pops back up when one starts. Pairs well with voice activation. While hidden, the tray icon brings it back.":
    "通話していない間はアバターが消え、通話が始まると再び現れます。音声起動と相性抜群。非表示の間はトレイアイコンから戻せます。",
  "Could not save that.": "保存できませんでした。",

  // ── Mascot settings window ────────────────────────────────────────────
  "Mascot settings": "マスコット設定",
  "Open mascot settings": "マスコット設定を開く",
  "The desktop mascot is part of the desktop app. Open this window from there.":
    "デスクトップマスコットはデスクトップアプリの機能です。このウィンドウはそちらから開いてください。",
  "The avatar isn't popped out. Most settings come alive when it is.":
    "アバターはポップアウトされていません。ほとんどの設定はポップアウトすると有効になります。",
  "Pop out avatar": "アバターをポップアウト",
  "Emotions & gestures": "感情とジェスチャー",
  "Companion & call": "コンパニオンと通話",
  "Share screen": "画面共有",
  "Pop back in": "アプリウィンドウに戻す",
  "Transcript window": "トランスクリプトウィンドウ",
  "Play on the desktop avatar right away, call or no call.":
    "通話の有無にかかわらず、デスクトップのアバターで即座に再生されます。",
  "Behavior": "動作",
  "Ghost mode": "ゴーストモード",
  "Clicks pass through to whatever is behind the window, and the avatar fades out of the cursor's way.":
    "クリックはウィンドウを素通りして背後のアプリに届き、アバターはカーソルを避けてフェードします。",
  "Follow the cursor": "カーソルを追う",
  "Eyes and head track your mouse across the desktop.":
    "目と頭がデスクトップ上のマウスを追いかけます。",
  "Keep the avatar above every other window.":
    "アバターを常に他のすべてのウィンドウの前面に表示します。",
  "Full body view": "全身ビュー",
  "Fade to": "フェード時の不透明度",
  "Whole character instead of the face. Drag to rotate, scroll to zoom, Shift + drag to move.":
    "顔のアップではなく全身を表示。ドラッグで回転、スクロールでズーム、Shift＋ドラッグで移動。",
  "Look": "見た目",
  "Show a background": "背景を表示",
  "Lighting": "ライティング",
  "Studio": "スタジオ",
  "Sunny day": "晴れの日",
  "Golden hour": "夕暮れ",
  "Night neon": "ナイトネオン",
  "Flat": "フラット",
  "Overcast": "曇り",
  "Moonlight": "月明かり",
  "Candlelight": "キャンドル",
  "Stage spotlight": "ステージスポット",
  "Backlit": "逆光",
  "Default lighting": "デフォルトのライティング",
  "Default effects": "デフォルトのエフェクト",
  "Default ambience": "デフォルトのアンビエンス",
  "Effects preset selected whenever this background is switched to. Leave blank to keep the current selection.":
    "この背景に切り替えるたびに選択されるエフェクトプリセット。空欄なら現在の選択を維持します。",
  "Ambience layer selected whenever this background is switched to. Leave blank to keep the current selection.":
    "この背景に切り替えるたびに選択されるアンビエンスレイヤー。空欄なら現在の選択を維持します。",
  "None (keep current)": "なし（現在の設定を維持）",
  "Lighting preset selected whenever this background is switched to. Leave blank to keep the current selection.":
    "この背景に切り替えたときに選択されるライティングプリセット。空欄なら現在の選択を維持します。",
  "Effects": "エフェクト",
  "Soft bloom": "ソフトブルーム",
  "Anime colour": "アニメ撮影風カラー",
  "Portrait": "ポートレート",
  "Cinematic": "シネマティック",
  "Art style": "画風",
  "Oil painting": "油彩",
  "Watercolour": "水彩",
  "Manga ink": "漫画のペン入れ",
  "Risograph": "リソグラフ",
  "Pixel art": "ドット絵",
  "Repaint the whole scene live in a medium: oil on canvas, watercolour, manga ink and screentone, a three-colour risograph print or pixel art. Your companion keeps moving, talking and blinking inside the painting.":
    "シーン全体をリアルタイムで描き直します：キャンバスの油彩、水彩、漫画のペンとスクリーントーン、三色のリソグラフ印刷、ドット絵。コンパニオンは絵の中でも動き、話し、まばたきします。",
  "Repaint your companion live in a medium, like a paper cut-out on the desktop.":
    "コンパニオンをリアルタイムで画材風に描き直します。デスクトップの上の切り絵のように。",
  "Ambience": "アンビエンス",
  "Rain": "雨",
  "Snow": "雪",
  "Cherry petals": "桜の花びら",
  "Fireflies": "蛍",
  "Embers": "火の粉",
  "Focus lines": "集中線",
  "Weather and atmosphere around your companion: rain, snow, drifting cherry petals, fireflies, rising embers or manga focus lines. They show on the desktop mascot too.":
    "コンパニオンの周りの天気と雰囲気：雨、雪、舞う桜の花びら、蛍、舞い上がる火の粉、漫画の集中線。デスクトップマスコットにも表示されます。",
  "Mood-reactive ambience": "気分に反応するアンビエンス",
  "Their mood picks the ambience: petals when happy, rain when sad, embers when angry, fireflies when relaxed, focus lines when surprised, then back to your choice.":
    "気分がアンビエンスを選びます。嬉しいと花びら、悲しいと雨、怒ると火の粉、リラックスすると蛍、驚くと集中線。その後はあなたの選択に戻ります。",
  "Mood marks": "感情マーク",
  "Their mood picks the ambience, then back to your pick.":
    "気分がアンビエンスを選び、その後はあなたの選択に戻ります。",
  "Manga-style marks by their head when their mood changes.":
    "気分が変わると頭のそばに漫符が現れます。",
  "Hair and clothes dodge the cursor, ruffle on quick sweeps and bounce when clicked.":
    "髪や服がカーソルを避け、素早い操作でなびき、クリックすると弾みます。",
  "Manga-style marks pop up by their head when their mood changes: a ♪ when happy, an anger mark when angry, an exclamation mark when surprised, a rain cloud when sad, a sigh puff when relaxed.":
    "気分が変わると頭のそばに漫符が現れます：嬉しいときは♪、怒ると怒りマーク、驚くと「！」、悲しいと雨雲、リラックスするとため息。",
  "Touch physics": "タッチ物理",
  "Hair, skirts and other swinging parts move out of the cursor's way, ruffle with quick mouse sweeps, and bounce when clicked.":
    "髪やスカートなどの揺れる部分がカーソルを避けて動き、素早いマウス操作でなびき、クリックすると弾みます。",
  "Window size": "ウィンドウサイズ",
  "Or scroll on the avatar (face view) for fine control.":
    "アバター上でスクロールしても微調整できます（フェイスビュー時）。",
  "Custom size": "カスタムサイズ",
  "Width (px)": "幅（px）",
  "Height (px)": "高さ（px）",
  "Apply": "適用",
  "Screen width": "画面の幅",
  "Set the width to this display's full width": "幅をこのディスプレイいっぱいに設定",
  "Screen height": "画面の高さ",
  "Set the height to this display's full height (taskbar excluded)":
    "高さをこのディスプレイいっぱいに設定（タスクバーを除く）",
  "Outfit": "衣装",
  "Placement": "配置",
  "Snap to corner": "コーナーに配置",
  "Next monitor": "次のモニターへ",
  "Visibility & startup": "表示と起動",
  "Hide avatar controls": "アバターの操作パネルを隠す",
  "The floating controls never show, even on hover. Right-click the avatar or use the tray to get back here.":
    "フローティング操作パネルをホバーしても一切表示しません。ここに戻るにはアバターを右クリックするかトレイを使ってください。",
  "Start as the desktop companion instead of the app window. From the next launch.":
    "アプリウィンドウではなくデスクトップのコンパニオンとして起動します。次回の起動から。",
  "Call ended after %s minutes with nothing happening.":
    "%s 分間なにも操作がなかったため通話を終了しました。",

  // ── Settings: companions ──────────────────────────────────────────────
  "Companions": "コンパニオン",
  "Restore presets": "プリセットを復元",
  "Re-create any deleted preset companions (Eve, Ara, Rex, Sal, Leo) with their original prompts. Existing companions are untouched.":
    "削除したプリセットコンパニオン（Eve・Ara・Rex・Sal・Leo）を元のプロンプトで再作成します。既存のコンパニオンには影響しません。",
  "New companion": "新しいコンパニオン",
  "Search companions…": "コンパニオンを検索…",
  "Search avatars…": "アバターを検索…",
  "No matches.": "一致するものはありません。",
  "Edit companion": "コンパニオンを編集",
  "Reset to stock": "初期設定に戻す",
  "Portrait — the thumbnail embedded in the main VRM. Updates when the VRM changes (after Save).": "ポートレート — メイン VRM に埋め込まれたサムネイルです。VRM を変更すると（保存後に）更新されます。",
  "Put this bundled companion's prompt, voice, avatar, wake phrase and tool settings back to how they shipped. Loads into the form — Save to apply, Discard to back out. Conversations, memories, lore and affection progress are kept.": "この同梱コンパニオンのプロンプト、音声、アバター、ウェイクフレーズ、ツール設定を出荷時の状態に戻します。フォームに読み込まれるだけなので、「保存」で反映、「破棄」で取り消せます。会話、記憶、ロア、好感度の進行は保持されます。",
  "Could not load the stock settings": "初期設定を読み込めませんでした",
  "voice:": "ボイス：",
  "Delete companion": "コンパニオンを削除",
  "Delete %s? This permanently removes the companion plus all its sessions, transcripts and memories.":
    "%s を削除しますか？ コンパニオンとそのセッション・トランスクリプト・メモリがすべて完全に削除されます。",
  "%s deleted.": "%s を削除しました。",
  "%s saved.": "%s を保存しました。",
  "Restored: %s.": "復元しました：%s。",
  "All preset companions are already present.": "プリセットコンパニオンはすべて揃っています。",
  "Restore failed": "復元に失敗しました",
  "Voice (built-in name or custom xAI voice id)": "ボイス（組み込み名またはカスタム xAI ボイス ID）",
  "Speech speed": "話す速さ",
  "How fast this companion talks on voice calls: 1.0 is the voice's normal pace, lower is slower (down to 0.7), higher is faster (up to 1.5). Takes effect from the next call.":
    "音声通話でこのコンパニオンが話す速さです。1.0 がボイス本来のペースで、下げるとゆっくり（最小 0.7）、上げると速く（最大 1.5）なります。次の通話から反映されます。",
  "Transcription key terms (comma-separated)": "文字起こしのキーワード（カンマ区切り）",
  "Names and words this companion's conversations use, so your speech is transcribed with the right spelling on voice calls — people, places, in-jokes, game words. Comma-separated, up to 100 terms of 50 characters each. Leave empty for none.":
    "このコンパニオンとの会話で使う名前や言葉です。音声通話であなたの話した言葉が正しい表記で文字起こしされるようにします — 人名、地名、内輪ネタ、ゲーム用語など。カンマ区切りで、1 語 50 文字まで、最大 100 語。空欄なら使いません。",
  "e.g. Minecraft, Mochi, Aldermoor": "例：Minecraft, Mochi, Aldermoor",
  "Avatar": "アバター",
  "(no avatar)": "（アバターなし）",
  "Reasoning effort (text mode)": "推論エフォート（テキストモード）",
  "System prompt": "システムプロンプト",
  "Computed voice prompt (read-only)": "算出されたボイスプロンプト（読み取り専用）",
  "Exactly what a solo voice session receives: the environment preamble, the system prompt, and the dynamic tool/expression/memory sections. Includes unsaved edits on this page.":
    "ソロボイスセッションが受け取る内容そのものです：環境プリアンブル、システムプロンプト、動的なツール・表現・メモリのセクション。このページの未保存の編集も反映されます。",
  "≈ tokens — system prompt: %s voice, %s text · tools: %s voice (%s tools), %s text (%s tools)":
    "≈ トークン数 — システムプロンプト：ボイス %s、テキスト %s · ツール：ボイス %s（%s 個）、テキスト %s（%s 個）",
  "Estimated from characters-per-token ratios measured with Grok's tokenizer on English text (within a few percent there); a prompt written in Japanese or similar reads low. Text chats get a slightly different prompt and a different tool set (no avatar or call tools, plus create_voicemail and code execution).":
    "Grok のトークナイザーで英語テキストを計測した「1トークンあたりの文字数」から概算しています（英語なら誤差数％）。日本語などで書かれたプロンプトは実際より少なく表示されます。テキストチャットではプロンプトが少し異なり、ツール構成も異なります（アバター・通話ツールなし、create_voicemail とコード実行あり）。",
  "Could not compute the prompt preview": "プロンプトプレビューを算出できませんでした",
  "Computing…": "算出中…",
  "When to call (shown to other companions for group calls)":
    "呼ぶタイミング（グループ通話で他のコンパニオンに表示）",
  "Shown to OTHER companions inside their add_agent_to_call tool so they know when to bring this companion into a live group call. Leave empty and other companions only see the name.":
    "他のコンパニオンの add_agent_to_call ツール内に表示され、このコンパニオンをいつ通話に呼ぶべきかの判断材料になります。空欄の場合、他のコンパニオンには名前のみが表示されます。",
  "e.g. 'Sales specialist — call for pricing, quotes, or negotiation roleplay.'":
    "例：「営業スペシャリスト — 価格・見積もり・交渉ロールプレイのときに呼んでください。」",

  // Affection meter
  "Affection": "好感度",
  // One-time offer before the first call/chat (AffectionOfferDialog)
  "Affection meter": "好感度メーター",
  "this companion": "このコンパニオン",
  "%s can keep an affection score that carries across calls. They start a little reserved and warm up as you get to know them, and how you treat them matters.":
    "%s は通話をまたいで持ち越される好感度スコアを持てます。最初は少し控えめで、あなたを知るにつれて打ち解けていきます。あなたの接し方が影響します。",
  "It adds their affection rules to every prompt plus an occasional silent tool call, so it uses a few more tokens. You can change this any time in the companion's settings.":
    "毎回のプロンプトに好感度ルールが追加され、ときどき無音のツール呼び出しが入るため、トークンを少し多く消費します。コンパニオンの設定からいつでも変更できます。",
  "Turn on the affection meter for %s": "%s の好感度メーターをオンにする",
  "Continue": "続行",
  "Enable affection meter": "好感度メーターを有効化",
  "Gives the companion a persistent affection score it adjusts in small steps via the adjust_affection tool as your relationship warms or cools. The current score and your affection rules below are injected into every session prompt, and score changes play a heart effect around the avatar.":
    "コンパニオンに永続的な好感度スコアを持たせます。関係が温まったり冷めたりすると adjust_affection ツールで少しずつ調整されます。現在のスコアと下の好感度ルールは毎セッションのプロンプトに注入され、スコアが変化するとアバターの周りにハートのエフェクトが再生されます。",
  "Affection animations": "好感度アニメーション",
  "Play the heart effect around the avatar (and mascot) when the score changes. With this off the meter still works — adjustments just happen invisibly.":
    "スコアが変化したときにアバター（とマスコット）の周りでハートのエフェクトを再生します。オフにしてもメーター自体は機能します — 調整が目に見えなくなるだけです。",
  "Current score": "現在のスコア",
  "Where the relationship stands right now. Normally the companion moves this itself, a few points at a time — edit it here to set a starting point, or to reset or hand-tune the relationship.":
    "現在の関係の状態です。通常はコンパニオン自身が数ポイントずつ動かします。開始値の設定、リセット、手動調整をしたいときにここで編集してください。",
  "Max score": "最大スコア",
  "The top of the scale — the score is kept between 0 and this.":
    "スケールの上限です。スコアは 0 からこの値の間に保たれます。",
  "Levels": "レベル数",
  "How many tiers the scale splits into. The companion's level is its score tier — write your affection rules against these levels.":
    "スケールを何段階に分けるかです。コンパニオンのレベルはスコアの段階に対応します。好感度ルールはこのレベルを基準に書いてください。",
  "Max change per adjustment": "1 回の調整での最大変化",
  "The most the companion can move the score in a single adjust_affection call — keeps the relationship building over many sessions instead of jumping levels in one turn.":
    "adjust_affection の 1 回の呼び出しでスコアを動かせる上限です。関係が 1 ターンで一気にレベルを跳び越えず、多くのセッションを通じて育つようにします。",
  "Max change (major events)": "最大変化（重大イベント）",
  "The clamp for severity-major calls — the rare relationship-defining events your affection rules describe (a confessed betrayal, a life-marking moment). Sized in points; two levels' worth by default.":
    "severity が major の呼び出しに適用される上限です。好感度ルールに記述された、関係を決定づけるまれなイベント（裏切りの告白、人生の節目となる出来事など）に使われます。ポイント単位で、デフォルトは 2 レベル分です。",
  "Affection rules (when to raise or lower the score, and how behaviour changes per level)":
    "好感度ルール（スコアを上げ下げするタイミングと、レベルごとの振る舞いの変化）",
  "Injected into every session prompt together with the current score — the companion is told to review these rules before every reply and shape its behaviour to the current level. Left empty, the level simply colours its warmth naturally.":
    "現在のスコアと一緒に毎セッションのプロンプトへ注入されます。コンパニオンは返答のたびにこのルールを確認し、現在のレベルに合わせて振る舞いを変えるよう指示されます。空欄の場合は、レベルに応じて自然に温かさが変わります。",
  "Leave empty to let the level simply colour the companion's warmth.":
    "空欄にすると、レベルに応じてコンパニオンの温かさが自然に変わります。",
  "Affection — level %s of %s. The companion adjusts this as your relationship evolves.":
    "好感度 — レベル %s / %s。関係の変化に合わせてコンパニオンが調整します。",

  // Agent flags
  "Tools": "ツール",
  "General": "一般",
  "wake:": "ウェイク：",
  "Voice & brain": "声と頭脳",
  "Summarise at (tokens)": "要約するサイズ（トークン）",
  "Once a request to this brain reaches this size - the companion's prompt (about 18,000 tokens) plus the conversation - the older part is summarised. Lower keeps replies quick; a local model needs it under its loaded context length, with room for the reply. 0 = never.":
    "この頭脳へのリクエストがこのサイズ（コンパニオンのプロンプト約 18,000 トークンと会話の合計）に達すると、古い部分を要約します。小さくすると返答が速く保たれます。ローカルモデルでは、読み込んだコンテキスト長より小さく、返答の余裕を残した値にしてください。0 = 要約しない。",
  "When a summary passes the high limit, it is rewritten down to about this many words. 0 = off (summaries keep growing).":
    "要約が上限を超えたら、この語数程度まで書き直します。0 = オフ（要約は増え続けます）。",
  "Below this, new conversation is added to the summary as it is; above it, the summary is rewritten down to the low limit.":
    "この語数までは新しい会話を要約にそのまま追記し、超えたら下限まで書き直します。",
  "Can see images": "画像を認識できる",
  "Turn on for a vision model (e.g. Qwen3.5, Gemma 4, a \"VL\" build with its projector loaded). Images you attach in chat reach it, and analyze_screen runs on it instead of Grok vision.":
    "画像認識モデル（Qwen3.5、Gemma 4、プロジェクター付きの「VL」版など）ならオンにします。チャットで添付した画像がモデルに届き、analyze_screen も Grok の画像認識の代わりにこのモデルで動きます。",
  "Unmarked tools run in the app and work with any brain, local ones included. Tools marked xAI use your xAI API key, and are left out while none is set.":
    "印のないツールはアプリ内で動き、ローカルを含むどの頭脳でも使えます。xAI の印があるツールは xAI API キーを使い、キーが未設定の間は提供されません。",
  "Uses your xAI API key when the companion uses it (billed by xAI). Not offered while no key is set.":
    "コンパニオンが使うときに xAI API キーを使います（xAI の課金）。キーが未設定の間は提供されません。",
  "The bot plans its moves on the connection picked in Game integrations → Minecraft: Grok on your xAI API key, OpenAI, Claude, or a server on your computer.":
    "ボットは ゲーム連携 → Minecraft で選んだ接続で行動を計画します：xAI API キーの Grok、OpenAI、Claude、または自分のコンピューター上のサーバー。",
  "xAI · OpenAI · Claude · local": "xAI・OpenAI・Claude・ローカル",
  "Grok or brain vision": "Grok または頭脳の画像認識",
  "Selfies, screenshots and clips run in the app. analyze_screen looks with the companion's own brain when it can see images (OpenAI, Claude or a local vision model, on the brain's quick model), otherwise with Grok vision on your xAI API key; left out when neither is available.":
    "自撮り・スクリーンショット・クリップはアプリ内で動きます。analyze_screen は、コンパニオンの頭脳が画像を認識できる（OpenAI、Claude、ローカルの画像認識モデル。頭脳のクイックモデルを使用）ならその頭脳で、そうでなければ xAI API キーで Grok の画像認識を使って見ます。どちらも使えないときは提供されません。",
  "Grok or setup voice": "Grok またはセットアップの声",
  "Recorded in the voice the companion has on calls: Grok's (your xAI API key, billed by xAI), or its voice setup's voice (OpenAI, Fish, Kokoro...). Left out when neither can speak.":
    "通話と同じ声で録音します。Grok の声（xAI API キー、xAI の課金）か、音声セットアップの声（OpenAI、Fish、Kokoro など）です。どちらも話せないときは提供されません。",
  "Runs on the companion's own brain when its voice setup's brain is OpenAI or Claude (their search, code and file reading, on the brain's quick model for quick checks); otherwise on Grok with your xAI API key (billed by xAI).":
    "コンパニオンの音声セットアップの頭脳が OpenAI か Claude なら、その頭脳で動きます（検索・コード・ファイル読み取り。クイックチェックは頭脳のクイックモデル）。それ以外は xAI API キーで Grok を使います（xAI の課金）。",
  "xAI or ComfyUI": "xAI または ComfyUI",
  "Each tool renders on Grok Imagine with your xAI API key, or on your own ComfyUI server - pick per tool in Settings → Local generation. A tool whose engine can't run is left out.":
    "各ツールは xAI API キーで Grok Imagine、または自分の ComfyUI サーバーで生成します。ツールごとに 設定 → ローカル生成 で選べます。エンジンが動かせないツールは提供されません。",
  "Follows Image & video tools' engines (Settings → Local generation).":
    "画像・動画ツールのエンジン（設定 → ローカル生成）に従います。",
  "xAI account": "xAI アカウント",
  "The Grok Build CLI signs in to your xAI account.": "Grok Build CLI は xAI アカウントにサインインして動きます。",
  "Grok brain": "Grok 頭脳",
  "Runs inside xAI's Grok models: only a companion whose brain is Grok has it.":
    "xAI の Grok モデル内で動きます。頭脳が Grok のコンパニオンだけが使えます。",
  "Grok voice for videos and songs (built-in name or custom xAI voice id)":
    "動画と歌用の Grok の声（内蔵の名前またはカスタム xAI 音声 ID）",
  "%s (the setup's default)": "%s（セットアップの既定）",
  "required - this setup has no default voice": "必須 — このセットアップに既定の声がありません",
  "Which of this engine's voices speaks the script. Leave empty for the voice setup's default voice.":
    "このエンジンのどの声でスクリプトを読み上げるか。空欄なら音声セットアップのデフォルトの声を使います。",
  "the setup's default voice": "セットアップのデフォルトの声",
  "Used by Grok text chat (Settings → Text model) and by this companion's delegated tasks. A voice setup's brain has its own reasoning setting.":
    "Grok のテキストチャット（設定 → テキストモデル）と、このコンパニオンの委任タスクで使われます。音声セットアップの頭脳には独自の推論設定があります。",
  "Provider tools": "プロバイダーのツール",
  "Tools the brain's provider runs itself, like remote MCP servers: xAI, OpenAI's own API or Anthropic. A brain on your own computer doesn't have them.":
    "リモート MCP サーバーと同じく、頭脳のプロバイダー（xAI、OpenAI 本家の API、Anthropic）自身が実行するツールです。自分のコンピューター上の頭脳では使えません。",
  "Not on calls with this brain: %s.": "この頭脳では通話で使えません：%s。",
  "Not in text chat with its brain: %s.": "その頭脳ではテキストチャットで使えません：%s。",
  "Runs at the brain's provider: xAI, OpenAI's own API or Anthropic. A local brain doesn't have it.":
    "頭脳のプロバイダー（xAI、OpenAI 本家の API、Anthropic）側で動きます。ローカルの頭脳では使えません。",
  "avatar:": "アバター：",
  "Avatar control tools": "アバター操作ツール",

  // Expression style fields
  "Signature gestures (optional)": "特徴的なジェスチャー（任意）",
  "Appended to the built-in avatar-expression instructions every voice session gets, under a 'Your signature gestures' heading. Name the gestures that are characteristically THIS companion's and the moments that call for them. The general mechanics are already covered - leave empty and the generic guidance stands alone.":
    "毎ボイスセッションに注入される組み込みのアバター表現指示に、「Your signature gestures」見出しの下で追記されます。このコンパニオンならではのジェスチャーと、それを使う場面を記述してください。一般的な仕組みは既に説明済みです。空欄の場合は汎用の指示のみになります。",
  "Gestures for reference: %s, plus any custom gestures on the avatar.":
    "参考までに利用できるジェスチャー：%s（アバターのカスタムジェスチャーも追加されます）。",
  "e.g. 'spin for a playful twirl on a real success; shoot as a terse copy-that.'":
    "例：「本当の成功には spin で軽やかに一回転、shoot は短い『了解』の合図。」",
  "Signature speech tags (optional)": "特徴的なスピーチタグ（任意）",
  "Appended to the built-in speech-tag instructions every Grok voice session gets, under a 'Your signature tags' heading. Name the tags that are characteristically THIS companion's and the moments that call for them; two or three example lines in their voice work well. The general mechanics are already covered - leave empty and the generic guidance stands alone.":
    "毎 Grok ボイスセッションに注入される組み込みのスピーチタグ指示に、「Your signature tags」見出しの下で追記されます。このコンパニオンならではのタグと、それを使う場面を記述してください。その口調での例文を2〜3行入れると効果的です。一般的な仕組みは既に説明済みです。空欄の場合は汎用の指示のみになります。",
  "Grok voice renders expression tags in speech. Inline: %s. Wrapping: %s. All of them are always available.":
    "Grok ボイスは音声に表現タグを反映します。インライン：%s。ラッピング：%s。すべて常に利用できます。",
  "Speech tags (%s)": "スピーチタグ（%s）",
  "Everything this companion is told about expression tags on this voice, on calls and for voice messages: how the tags work and which exist. A voice engine with tags of its own (Fish Audio) starts with its default text; trim the lists, reword it, or add this companion's signature tags at the end. For any other voice it starts empty and nothing is taught: if the model behind it understands tags, describe them here. Saved empty, it goes back to the default.":
    "この音声の表現タグについて、通話とボイスメッセージでこのコンパニオンに伝える内容のすべてです（タグの仕組みと種類）。独自のタグを持つ音声エンジン（Fish Audio）では、最初にそのデフォルトの文章が入っています。一覧を絞る、書き換える、末尾にこのコンパニオンならではのタグを加える、といった編集ができます。それ以外の音声では最初は空で、何も教えません。その音声のモデルがタグを理解するなら、ここに書いてください。空で保存するとデフォルトに戻ります。",
  "Nothing is taught about tags on this voice. If its model understands any, describe them here: how they are written, which exist, and when this companion uses them.":
    "この音声では、タグについて何も教えません。モデルがタグを理解する場合は、書き方・種類・このコンパニオンが使う場面をここに書いてください。",
  "This voice has expression tags of its own, so companions are taught those instead of Grok's, on calls and for voice messages. Each companion's version is in its editor (Speech tags).":
    "この音声には独自の表現タグがあるため、通話でもボイスメッセージでも、コンパニオンには Grok のタグの代わりにそちらを教えます。コンパニオンごとの内容は、その編集画面（スピーチタグ）にあります。",
  "This voice runs on %s, not xAI: the script is sent to it as written, so Grok's speech tags aren't rendered, {voice …} lines don't switch voices, and nothing is billed by xAI.":
    "この音声は xAI ではなく %s で動きます。スクリプトは書かれたとおりに送られるため、Grok のスピーチタグは表現されず、{voice …} 行で声は切り替わりません。xAI の課金もありません。",
  "Speech tags for this voice": "この音声のスピーチタグ",
  "%s speech characters": "読み上げ %s 文字",
  "e.g. 'Favour [pause] and <slow> for weight; [chuckle] for dry humor.'":
    "例：「重みを出すときは [pause] と <slow> を、乾いたユーモアには [chuckle] を好んで使う。」",
  "Call-companion tool (group calls)": "コンパニオン呼び出しツール（グループ通話）",
  "Companion texting (text_companion)": "コンパニオンテキスト（text_companion）",
  "Web search": "Web 検索",
  "X search": "X 検索",
  "Grok Imagine": "Grok Imagine",
  "Memory": "メモリ",
  "Core memory cap": "コア記憶の上限",
  "Maximum number of \"core\" memories (name, preferences, ongoing projects, and the like) pinned verbatim into every session prompt. Recall memories, searched on demand, aren't affected. Raise it for a longer pinned profile at the cost of prompt tokens; lower it to keep sessions lean. When the cap is hit, the companion is nudged to use its own judgement about what to forget — not simply the oldest core memory.":
    "「コア」記憶（名前、好み、進行中のプロジェクトなど）として、毎セッションのプロンプトにそのまま常時挿入される件数の上限です。必要に応じて検索されるリコール記憶には影響しません。上限を上げるとプロフィールをより長く固定できますが、プロンプトのトークン消費が増えます。下げるとセッションを軽量に保てます。上限に達すると、単に一番古いコア記憶を忘れるのではなく、何を忘れるべきかコンパニオン自身の判断で考えるよう促されます。",
  "Code execution (text)": "コード実行（テキスト）",

  // History tab
  "History": "履歴",

  // Confirm dialog
  "Are you sure?": "本当によろしいですか？",
  "Confirm": "確認",

  // Pager
  "Previous page": "前のページ",
  "Next page": "次のページ",
  "Records per page": "1 ページあたりの件数",

  // Lore stories
  "Lore stories": "ロアストーリー",
  "The full shared archive, across all companions. Each companion can recall the stories tagged with their name via the recall_stories tool.":
    "全コンパニオン共有のアーカイブ全体です。各コンパニオンは recall_stories ツールで、自分の名前がタグ付けされたストーリーを呼び出せます。",
  "Search title, text, characters, tags…": "タイトル・本文・キャラクター・タグを検索…",
  "All characters": "すべてのキャラクター",
  "All tags": "すべてのタグ",
  "%s of %s stories": "%s / %s 件のストーリー",
  "Download the stories as a JSON file (respects the character filter)":
    "ストーリーを JSON ファイルとしてダウンロードします（キャラクターフィルターが適用されます）",
  "Import a lore JSON file — stories are matched by title, existing ones are kept":
    "ロア JSON ファイルをインポートします。ストーリーはタイトルで照合され、既存のものは維持されます",
  "Imported %s stories (%s duplicates skipped).":
    "%s 件のストーリーをインポートしました（重複 %s 件をスキップ）。",
  "None of the characters (%s) match an existing companion, so no companion will be able to recall this story. Save anyway?":
    "キャラクター（%s）はいずれも既存のコンパニオンと一致しないため、どのコンパニオンもこのストーリーを呼び出せません。それでも保存しますか？",
  "No characters are tagged, so no companion will be able to recall this story. Save anyway?":
    "キャラクターがタグ付けされていないため、どのコンパニオンもこのストーリーを呼び出せません。それでも保存しますか？",
  "Lore stories can be added after the companion is saved.":
    "ロアストーリーは、コンパニオンの保存後に追加できます。",
  "Add story": "ストーリーを追加",
  "Written stories from this companion's past, recalled on demand via the recall_stories tool. Tag every character present in the story; stories are shared, so a story tagged with several companions appears for each of them.":
    "このコンパニオンの過去を綴ったストーリーで、recall_stories ツールから必要に応じて呼び出されます。ストーリーに登場するキャラクター全員をタグ付けしてください。ストーリーは共有されるため、複数のコンパニオンをタグ付けしたストーリーはそれぞれに表示されます。",
  "No stories yet.": "ストーリーはまだありません。",
  "Read": "読む",
  "Hide": "隠す",
  "Story title": "ストーリータイトル",
  "Lore stories (recall_stories)": "ロアストーリー（recall_stories）",
  "Lets the companion look up its lore stories on demand (recall_stories). Only offered when at least one story below is tagged with the companion's name.":
    "コンパニオンが必要に応じてロアストーリーを参照できるようにします（recall_stories）。下のストーリーにコンパニオンの名前がタグ付けされている場合にのみ提供されます。",
  "Built-in xAI voice names such as ara work as-is. For a custom voice, create or clone one in the xAI console (console.x.ai) and paste its voice id here. Custom voices only work on an xAI API key, not while signed in with Grok.":
    "ara などの xAI 組み込みボイス名はそのまま使えます。カスタムボイスは xAI コンソール（console.x.ai）で作成またはクローンし、そのボイス ID をここに貼り付けてください。カスタムボイスは xAI API キーでのみ使え、Grok でサインイン中は使えません。",
  "Fast text model (delegate tool)":
    "高速テキストモデル（委任ツール）",
  "Quicker, shallower text model that delegate_task can pick with model='fast' for looking at images, screenshots and clips or reading short documents. Empty = same as the Text model.":
    "delegate_task が model='fast' で選べる、より速く浅いテキストモデルです。画像やスクリーンショット、クリップの確認、短い文書の読み取りに使います。空欄 = テキストモデルと同じ。",
  "Web & X searches per reply": "返信あたりの Web / X 検索回数",
  "How many web and X searches xAI may run inside one text reply (chats, heartbeats, companion texts). Each search re-reads the whole conversation. Past this, the reply is stopped and written again without searching, marked \"search limit\". Other tools, including code and MCP, don't count. 0 = no limit.":
    "テキスト返信 1 回（チャット、ハートビート、コンパニオン間のテキスト）の中で xAI が実行できる Web 検索と X 検索の回数です。検索のたびに会話全体を読み直します。超えるとその返信を止め、検索なしで書き直し、「検索上限」と表示します。コード実行や MCP など他のツールは数えません。0 = 上限なし。",
  "xAI max turns (all xAI tools)": "xAI 最大ターン数（すべての xAI ツール）",
  "Sent to xAI as max_turns: its own limit on how many rounds of tool use (search, code, MCP) one reply may take. xAI doesn't reliably enforce it (web search runs past it, hence the search limits beside this), so keep it generous: it's a catch-all for code and MCP, not the main cap. 0 = not sent (xAI's default).":
    "xAI に max_turns として送られる、返信 1 回で行えるツール使用（検索、コード、MCP）のラウンド数の上限です。xAI は確実には守らないため（Web 検索はこれを超えて続くので、隣の検索上限があります）、余裕のある値にしてください。主な上限ではなく、コードと MCP のための保険です。0 = 送信しない（xAI の既定）。",
  "Web & X searches per research task (multi-agent)": "調査タスクあたりの Web / X 検索回数（マルチエージェント）",
  "How many web and X searches the lead agent may run in one multi-agent research task. Past this, the task stops and your companion is told it failed. Searches by its helper agents aren't visible to the app, so they can't be counted. 0 = no limit.":
    "マルチエージェント調査タスク 1 回でリードエージェントが実行できる Web 検索と X 検索の回数です。超えるとタスクを止め、コンパニオンに失敗が伝えられます。補助エージェントの検索はアプリから見えないため、数えられません。0 = 上限なし。",
  "Manage keys, usage and custom voices in the":
    "API キー、使用量、カスタムボイスの管理は",
  "xAI console":
    "xAI コンソール",
  "Model rates:":
    "モデル料金：",
  "How voice calls are billed (approximate, check xAI pricing for current rates): a voice call is charged per minute for as long as it stays connected, whether or not anyone is speaking. That is about $0.08 a minute ($4.80 an hour) on grok-voice-think-fast-2.0, for each companion in the call. On top of that there is a flat fee of about $0.004 per message exchanged, whatever its length. Tools like web search and Grok Imagine (images and videos) are charged separately. Resuming a voice conversation sends its history back one message at a time (incurring the $0.004 charge per message), so if you resume often, review the \"Grok Realtime calls\" section in Settings. Text chat is billed differently, by the number of tokens, at the rates of the model used.":
    "音声通話の課金の仕組み（概算です。最新の料金は xAI 料金で確認してください）：音声通話は、誰かが話しているかどうかに関係なく、接続している間ずっと分単位で課金されます。grok-voice-think-fast-2.0 では 1 分あたり約 $0.08（1 時間あたり $4.80）で、通話に参加しているコンパニオンごとにかかります。これに加えて、やり取りされるメッセージ 1 件ごとに、長さに関係なく一律で約 $0.004 の料金がかかります。ウェブ検索や Grok Imagine（画像・動画）などのツールは別途課金されます。音声での会話を再開すると、履歴がメッセージ 1 件ずつ送り直される（1 件ごとに $0.004 の料金がかかります）ため、頻繁に再開する場合は、設定の「Grok Realtime の通話」セクションを見直してください。テキストチャットは課金方法が異なり、使用するモデルの料金でトークン数に応じて課金されます。",
  "Capture tools (selfie & screen share)":
    "キャプチャツール（自撮り＆画面共有）",
  "Lets the companion take a photo of itself when you ask (take_selfie: the live avatar in calls, its portrait in chat) and, once you've shared your screen, grab screenshots or short clips of it (take_screenshot, analyze_screen, record_screen_clip). Captures land in the files library for the transcript and for other tools to use. Nothing is generated, so this works with any provider.":
    "頼まれたときにコンパニオンが自分の写真を撮れるようにします（take_selfie — 通話中はライブのアバター、チャットではポートレート）。また、画面共有を開始していれば、そのスクリーンショットや短いクリップを取得できます（take_screenshot、analyze_screen、record_screen_clip）。キャプチャはファイルライブラリに保存され、トランスクリプトや他のツールから利用できます — 何も生成しないため、どのプロバイダーでも使えます。",
  "Image & video tools": "画像・動画ツール",
  "Unlocks the media tools: create_image and create_video (from a prompt, or remixing images in the Imagine library: selfies, screenshots and your uploads), plus in voice calls change_background (generate a new scene behind the avatar). Each tool renders on Grok Imagine (billed by xAI: images cost cents, videos are priced per second) or on your own ComfyUI server. Pick the engine per tool in Settings → Local generation.":
    "メディアツールを有効にします：create_image と create_video（プロンプトから、または Imagine ライブラリの画像（セルフィー、スクリーンショット、アップロード）をリミックス）、さらに音声通話では change_background（アバターの背後に新しいシーンを生成）。各ツールは Grok Imagine（xAI が課金：画像は数セント、動画は秒単位）か、自分の ComfyUI サーバーで実行されます。エンジンはツールごとに 設定 → ローカル生成 で選びます。",
  "Cross-companion Imagine reference": "コンパニオン間 Imagine 参照",
  "Lets create_image/create_video feature ANOTHER companion by name (and outfit) — their own portrait as a reference image, and (create_video) their own voice id so a clip can have them speak in their actual voice too. Separate from Companion texting on purpose: a companion can be messageable without being depicted this way, or vice versa. Requires Image & video tools.":
    "create_image／create_video で、名前（と衣装）を指定して「別の」コンパニオンを登場させられるようにします — 参照画像としてその人自身のポートレート、そして（create_video では）実際の声で話させるためのその人自身のボイス ID も使えます。「コンパニオンテキスト」とは意図的に別設定です：テキストは送れても、この形で登場させたくない（またはその逆の）コンパニオンがいてもよいためです。画像・動画ツールが必要です。",
  "xAI pricing":
    "xAI 料金",
  "Lets the companion animate its avatar during voice calls: set its facial emotion, play gestures (the built-in set plus the avatar's custom ones) and switch between the avatar's outfits (set_emotion, play_gesture, change_outfit). Blinking, lip sync and idle motion work regardless. Unlocks the expression-style notes below.":
    "音声通話中にコンパニオンがアバターを動かせるようにします：表情の切り替え、ジェスチャーの再生（組み込みセットとアバター固有のカスタムジェスチャー）、アバターの衣装の切り替え（set_emotion、play_gesture、change_outfit）。まばたき、リップシンク、待機モーションはこの設定に関係なく動きます。下の表現スタイル欄が有効になります。",
  "Lets the companion bring other companions into the current voice call and send them away again (add_agent_to_call, remove_agent_from_call), e.g. when you ask to talk to someone else or want a group conversation. Voice mode only.":
    "コンパニオンが現在の音声通話に他のコンパニオンを呼び入れたり退出させたりできるようにします（add_agent_to_call、remove_agent_from_call）— 別のコンパニオンと話したいときやグループ会話をしたいときに。ボイスモードのみ。",
  "Lets the companion send an async text to another companion and get their reply back (text_companion), mid voice call or chat — e.g. checking in on someone or passing along news. The message lands in the other companion's own conversation, clearly marked as coming from a companion rather than you. One reply per text; it doesn't turn into an unsupervised back-and-forth.":
    "コンパニオンが、音声通話やチャットの最中に別のコンパニオンへ非同期でテキストを送り、返信を受け取れるようにします（text_companion） — 例えば様子を伺ったり近況を伝えたりする用途です。メッセージは相手コンパニオン自身の会話に届き、あなたではなくコンパニオンからのものだと明確に分かるようになっています。返信は1通のみで、際限のない自動応酬にはなりません。",
  "Gives the companion long-term memory tools (remember, recall, forget): it can save facts about you and your conversations, search them later, and delete ones you ask it to drop. Memories persist across sessions and appear in the Memories tab.":
    "コンパニオンに長期記憶ツール（remember、recall、forget）を与えます：あなたや会話についての事実を保存し、後で検索し、頼まれたものを削除できます。メモリはセッションをまたいで保持され、メモリタブに表示されます。",
  "Lets the companion drive the Minecraft bot set up in the Games tab from voice and text sessions: give it goals and commands, check what it's doing (minecraft_command, minecraft_status). The tools are only offered while the bot sidecar is connected.":
    "ゲームタブで設定した Minecraft ボットをコンパニオンが操作できるようにします — 目標や指示を出したり状況を確認したり（minecraft_command、minecraft_status） — ボイス／テキストの両セッションから。ツールはボットのサイドカーが接続されている間のみ提供されます。",
  "Lets the companion end the voice call itself (end_call) when you say goodbye or ask it to hang up, instead of waiting for you to press the button. Voice mode only.":
    "あなたが別れを告げたり切るよう頼んだりしたとき、ボタンを押すのを待たずにコンパニオン自身が通話を終了できるようにします（end_call）。ボイスモードのみ。",
  "Lets the companion search the web (web_search) for current information (news, facts, prices) in both voice and text sessions. Searches are billed per search by the provider that runs them (xAI, OpenAI or Anthropic).":
    "コンパニオンがボイス／テキストの両セッションで最新情報（ニュース、事実、価格など）をウェブ検索できるようにします（web_search）。検索は実行するプロバイダー（xAI、OpenAI、Anthropic）により 1 回ごとに課金されます。",
  "Lets the companion search posts on X (Twitter) in both voice and text sessions (x_search). Searches are billed by xAI per call.":
    "コンパニオンがボイス／テキストの両セッションで X（Twitter）の投稿を検索できるようにします（x_search）。検索は xAI により 1 回ごとに課金されます。",
  "Lets the companion run Python in its brain provider's sandboxed code interpreter (xAI, OpenAI or Anthropic) to calculate, analyse data or test snippets. On Grok, text sessions only (Grok Realtime calls have no code tool); a voice setup with a Claude or OpenAI brain runs it on calls too. On Claude and OpenAI, attached files the model can't read directly (archives, older Office files, very long text...) are opened there, and files it makes come back into the chat.":
    "コンパニオンが頭脳のプロバイダー（xAI、OpenAI、Anthropic）のサンドボックス化されたコードインタープリタで Python を実行し、計算やデータ分析、スニペットのテストを行えるようにします。Grok ではテキストセッションのみ（Grok Realtime の通話にはコードツールがありません）。Claude または OpenAI の頭脳を使う音声セットアップでは通話でも使えます。Claude と OpenAI では、モデルが直接読めない添付ファイル（アーカイブ、古い Office ファイル、非常に長いテキストなど）がそこで開かれ、作成したファイルはチャットに戻ってきます。",
  "Lets the companion hand complex work (reading documents or images, research, long coding tasks) to a hidden background text session with the full tool stack, and report the result back (delegate_task). Works from voice calls too, where the realtime model can't see files itself. Quick looks at images and clips can run on the fast text model set in Settings. Each task is billed as extra text-model usage.":
    "文書や画像の読み取り、リサーチ、長いコーディング作業などの複雑な仕事を、フルツール構成の非表示のバックグラウンドテキストセッションに任せ、結果を報告させられるようにします（delegate_task）。リアルタイムモデル自身がファイルを見られない音声通話からも使えます。タスクごとにテキストモデルの追加使用量として課金されます。",
  "Allows delegated tasks (affects delegate_task) to run on xAI's multi-agent model (several coordinated agents on one task) when the companion asks for it. Noticeably more expensive per task than a plain delegation; requires Task delegation.":
    "コンパニオンが求めた場合に、委任タスク（delegate_task に影響）を xAI のマルチエージェントモデル（1 つのタスクに複数のエージェントが連携）で実行できるようにします。通常の委任よりタスクあたりのコストが明らかに高くなります。タスク委任が必要です。",
  "Lets the companion hand tasks to the xAI Grok Build CLI on THIS computer (local_task): it creates and edits real files and runs shell commands, auto-approved, in the folder it's given. Powerful, so only enable it for companions you trust with that. Requires the `grok` CLI on your PATH; never offered in Docker.":
    "コンパニオンがこのコンピュータ上の xAI Grok Build CLI にタスクを任せられるようにします（local_task）：指定フォルダ内で実際のファイルを作成・編集し、シェルコマンドを確認なしで実行します。強力な機能です — それを任せられると信頼できるコンパニオンにのみ有効にしてください。PATH 上に `grok` CLI が必要で、Docker では提供されません。",
  "Tags (optional, comma-separated)": "タグ（任意、カンマ区切り）",
  "Optional lowercase tags, comma-separated: life periods (childhood, teens, university, twenties, career, pre-crew, lost-years, crew-era, ongoing) plus free topic tags. The companion can filter and search its story list by these, and the full tag set is listed in its tool description.":
    "任意の小文字タグをカンマ区切りで入力します：人生の時期（childhood、teens、university、twenties、career、pre-crew、lost-years、crew-era、ongoing）と自由なトピックタグ。コンパニオンはこれでストーリー一覧を絞り込み・検索でき、タグ一覧はツール説明にも記載されます。",
  "e.g. 'childhood, sad'": "例：「childhood, sad」",
  "Description (who, what, when - shown in the story list)":
    "説明（誰が・何を・いつ - ストーリー一覧に表示）",
  "One line the companion sees when listing stories: who is involved, the main plot points, roughly when it happened. Without it, only the title tells the companion what a story is about.":
    "ストーリー一覧でコンパニオンが目にする 1 行です：登場人物、主な出来事、おおよその時期。これがないと、タイトルだけでストーリーの内容を判断することになります。",
  "Characters (comma-separated names)": "キャラクター（カンマ区切りの名前）",
  "Every character present in the story, comma-separated. Plain names: tagging a companion that doesn't exist on an install is fine, the name just stays in the list.":
    "ストーリーに登場するキャラクターをカンマ区切りで入力します。ただの名前なので、その環境に存在しないコンパニオンをタグ付けしても問題ありません。名前はリストに残るだけです。",
  "e.g. 'Eve, Ara'": "例：「Eve, Ara」",
  "Story": "ストーリー",
  "Save story": "ストーリーを保存",
  "Could not load lore stories": "ロアストーリーを読み込めませんでした",
  "Could not save the story": "ストーリーを保存できませんでした",
  "Delete the story '%s'? It disappears from every companion tagged in it.":
    "ストーリー「%s」を削除しますか？ タグ付けされたすべてのコンパニオンから消えます。",

  // ── Settings: MCP ─────────────────────────────────────────────────────
  "Remote MCP connections": "リモート MCP 接続",
  "Remote MCP connections can be added after the companion is saved.":
    "リモート MCP 接続は、コンパニオンの保存後に追加できます。",
  "Add connection": "接続を追加",
  "None configured. An MCP server gives this companion extra tools; the brain's provider (xAI, OpenAI or Anthropic) connects to it directly, so the URL must be public HTTPS.":
    "未設定です。MCP サーバーはこのコンパニオンにツールを追加します。頭脳のプロバイダー（xAI、OpenAI、Anthropic）が直接接続するため、URL は公開 HTTPS である必要があります。",
  "Could not load MCP connections": "MCP 接続を読み込めませんでした",
  "Remove MCP connection %s?": "MCP 接続 %s を削除しますか？",
  "Server label (a-z, 0-9, _ — shown to the model)": "サーバーラベル（a-z・0-9・_ — モデルに表示）",
  "Server URL (public https://)": "サーバー URL（公開 https://）",
  "Description (hint to the model about when to use this server)":
    "説明（このサーバーをいつ使うかのモデルへのヒント）",
  "Bearer token": "Bearer トークン",
  "(saved — blank keeps it)": "（保存済み — 空欄のままなら維持）",
  "(optional)": "（任意）",
  "Extra headers (JSON object, optional)": "追加ヘッダー（JSON オブジェクト、任意）",
  "Allowed tools (one per line — blank allows all)": "許可ツール（1 行に 1 つ — 空欄で全許可）",
  "Voice sessions": "音声セッション",
  "Text sessions": "テキストセッション",
  "Active": "有効",
  "Save connection": "接続を保存",
  "Save settings": "設定を保存",

  // ── Avatars / packs ───────────────────────────────────────────────────
  "Avatars": "アバター",
  "Import pack": "パックをインポート",
  "Importing…": "インポート中…",
  "Deleting…": "削除中…",
  "Import an avatar pack (.zip) — a zipped pack folder from any rexclaw install":
    "アバターパック（.zip）をインポート — 他の rexclaw からの zip 化されたパックフォルダ",
  "Export as avatar pack (.zip)": "アバターパック（.zip）としてエクスポート",
  "%s imported.": "%s をインポートしました。",
  "Export companion package (.zip) — settings and prompt, plus avatar, lore, memories and sessions on their own toggles; shareable with any rexclaw install":
    "コンパニオンパッケージ（.zip）をエクスポート — 設定とプロンプトに加えて、アバター・ロア・メモリ・セッションをそれぞれ選んで同梱。どの rexclaw にも取り込めます",
  "The avatar pack (models, outfits, backgrounds)": "アバターパック（モデル、衣装、背景）",
  "Lore stories tagged with this companion": "このコンパニオンがタグ付けされたロアストーリー",
  "What the companion remembers about you — personal; leave off when sharing": "コンパニオンがあなたについて覚えていること — 個人的な内容です。共有するときはオフのままに",
  "Your full conversation transcripts — personal; leave off when sharing": "会話の全文トランスクリプト — 個人的な内容です。共有するときはオフのままに",
  "Download package": "パッケージをダウンロード",
  "Import a companion package (.zip) exported from another rexclaw install":
    "他の rexclaw からエクスポートしたコンパニオンパッケージ（.zip）をインポート",
  "Imported %s with avatar %s — %s memories, %s sessions.":
    "%s をアバター %s と一緒にインポートしました — メモリ %s 件・セッション %s 件。",
  "Imported %s — %s memories, %s sessions.":
    "%s をインポートしました — メモリ %s 件・セッション %s 件。",
  "Added the voice connection %s for this companion — enter its API key in Settings → Models & providers.":
    "このコンパニオン用に音声接続 %s を追加しました — 設定 → モデルとプロバイダーで API キーを入力してください。",
  "New avatar": "新しいアバター",
  "Edit avatar": "アバターを編集",
  "Could not load avatars": "アバターを読み込めませんでした",
  "Create failed": "作成に失敗しました",
  "Could not open avatar": "アバターを開けませんでした",
  "Give the avatar a name.": "アバターに名前を付けてください。",
  "Upload a main VRM file.": "メイン VRM ファイルをアップロードしてください。",
  "%s saved to data/avatars/%s/": "%s を data/avatars/%s/ に保存しました",
  "Delete avatar": "アバターを削除",
  "Delete avatar %s? Companions using it lose their avatar. This removes the pack folder and its files.":
    "アバター %s を削除しますか？ 使用中のコンパニオンはアバターを失います。パックフォルダとそのファイルも削除されます。",
  "outfits": "衣装",
  "gestures": "ジェスチャー",
  "backgrounds": "背景",
  "used by": "使用中：",
  "bundled": "同梱",
  "Bundled avatars ship with the app and are read-only. Duplicate one to customize it.":
    "同梱アバターはアプリ付属で読み取り専用です。カスタマイズするには複製してください。",
  "Duplicate — make an editable copy (e.g. to add custom gestures to a bundled avatar)":
    "複製 — 編集可能なコピーを作成（同梱アバターにカスタムジェスチャーを追加したいときなど）",
  "Name for the copy (also names the pack folder):":
    "コピーの名前（パックフォルダ名にもなります）：",
  "Duplicate failed": "複製に失敗しました",
  "Duplicate companion (settings and prompt only — history and memories stay with the original)":
    "コンパニオンを複製（設定とプロンプトのみ — 履歴と記憶は元のコンパニオンに残ります）",
  "%s created.": "%s を作成しました。",
  "New and edited avatars are saved as packs under":
    "新規・編集したアバターはパックとして保存されます：",
  "shareable folders anyone can drop into another install. Bundled avatars are read-only.":
    "誰でも別のインストールに配置できる共有可能なフォルダです。同梱アバターは読み取り専用です。",
  "(none)": "（なし）",
  "Avatar name": "アバター名",
  "Main VRM (required)": "メイン VRM（必須）",
  "Idle animation VRMA (optional)": "待機アニメーション VRMA（任意）",
  "Physical description": "身体的な特徴",
  "Face, hair, eyes, build, species… — what the character looks like regardless of clothing.":
    "顔・髪・目・体つき・種族など — 服装に関係なくキャラクターがどう見えるか。",
  "Main outfit name": "メイン衣装の名前",
  "e.g. Lab coat": "例：白衣",
  "Main outfit description": "メイン衣装の説明",
  "What the main VRM wears — fed to the LLM, the image tools read it too. Each extra outfit below carries its own.":
    "メイン VRM が着ている服 — LLM に渡され、画像ツールも参照します。下の各衣装には、それぞれの説明があります。",
  "Fade emotions back to neutral": "表情を自然に戻す",
  "Library…": "ライブラリ…",
  "(bundled)": "（同梱）",
  "Pick from the shared asset library — files in data/assets/ plus bundled assets, usable by every avatar":
    "共有アセットライブラリから選択 — data/assets/ 内のファイルと同梱アセットは、どのアバターからも利用できます",
  "Shared files: drop them into": "共有ファイル：次の場所に置くと",
  "every upload field's Library picker can then reference the same file from any avatar, no duplicate uploads.":
    "各アップロード欄の「ライブラリ」から、どのアバターでも同じファイルを参照できます。重複アップロードは不要です。",
  "Full-body portraits (Generate portrait ▾) are what the companion uses as their likeness for pictures of themselves in text chat. Generate one for the main look and each outfit.":
    "全身ポートレート（「ポートレートを生成 ▾」）は、テキストチャットでコンパニオンが自分の写真を作るときの見た目として使われます。メインの姿と各衣装ごとに生成しておきましょう。",
  "Generate portrait": "ポートレートを生成",
  "Face portrait": "顔ポートレート",
  "Full-body portrait": "全身ポートレート",
  "All — face + full body, main and every outfit": "すべて — 顔と全身、メインと全衣装",
  "Rendering…": "レンダリング中…",
  "Full-body portrait — generated here; none yet if empty.": "全身ポートレート — ここで生成します。空欄ならまだ未生成です。",
  "Full-body portrait — what the companion looks like in this outfit for pictures of themselves in text chat":
    "全身ポートレート — テキストチャットで自分の写真を作るときの、この衣装での見た目です",
  "Outfit portrait": "衣装ポートレート",
  "Emotions the companion sets fade back toward neutral after a few seconds. Turn off to hold each expression until the next one.":
    "コンパニオンが設定した表情は数秒後に自然な表情へ戻ります。オフにすると次の表情まで保持されます。",
  "Pack folder:": "パックフォルダ：",
  "named after this avatar when you save.": "保存時にこのアバター名が付きます。",
  "fixed folder id; renaming the avatar above doesn't move it.":
    "フォルダ ID は固定です。上でアバター名を変更してもフォルダは移動しません。",
  "Outfits": "衣装",
  "Description (fed to the LLM — when to wear it)": "説明（LLM に渡されます — いつ着るか）",
  "Custom gestures": "カスタムジェスチャー",
  "enum (e.g. wave_hello)": "enum（例：wave_hello）",
  "Description (when to use it)": "説明（いつ使うか）",
  "loop": "ループ",
  "Combo gestures (two characters)": "コンボジェスチャー（2 キャラクター）",
  "enum (e.g. dance_together)": "enum（例：dance_together）",
  "Base VRMA": "ベース VRMA",
  "Partner avatar name (optional — else upload a VRM)":
    "パートナーのアバター名（任意 — 未指定なら VRM をアップロード）",
  "Existing avatar to load as the second character (name or pack folder). Leave empty to upload a dedicated Partner VRM instead.":
    "2 人目のキャラクターとして読み込む既存アバター（名前またはパックフォルダ）。空欄の場合は専用のパートナー VRM をアップロードします。",
  "Partner VRM": "パートナー VRM",
  "Partner VRMA": "パートナー VRMA",
  "Base avatar placement during the combo. Offsets in metres; rotations in degrees applied yaw → pitch → roll (yaw 0 = facing the camera; pitch 90 = lying on the back — pair with a positive Y offset since models pivot at their feet).":
    "コンボ中のベースアバターの配置。オフセットはメートル、回転は度で yaw → pitch → roll の順に適用（yaw 0 = カメラ正面、pitch 90 = 仰向け — モデルの原点は足元なので正の Y オフセットと併用）。",
  "Partner placement during the combo — same conventions as the base avatar, plus a uniform scale.":
    "コンボ中のパートナーの配置 — ベースアバターと同じ規則に加え、一律スケールを指定できます。",
  "Looping combos: both clips should have the same duration or they drift out of phase with each repeat.":
    "ループするコンボでは、両クリップの長さを揃えてください。異なると繰り返すたびにズレていきます。",
  "Combo gestures animate two characters at once: this avatar plays the Base VRMA while a second VRM — an existing avatar or a dedicated upload — plays the Partner VRMA in sync (dancing together, hugging, …). The partner unloads when the gesture ends or is replaced.":
    "コンボジェスチャーは 2 キャラクターを同時にアニメーションします。このアバターがベース VRMA を再生する間、2 人目の VRM（既存アバターまたは専用アップロード）がパートナー VRMA を同期再生します（一緒にダンス、ハグなど）。ジェスチャーが終了するか差し替えられると、パートナーはアンロードされます。",
  "Backgrounds": "背景",
  "Preset": "プリセット",
  "Image": "画像",
  "3D scene (GLB)": "3D シーン（GLB）",
  "Video (muted loop)": "動画（無音ループ）",
  "Indigo gradient": "インディゴ グラデーション",
  "Slate gradient": "スレート グラデーション",
  "Studio gradient (light)": "スタジオ グラデーション（明）",
  "Charcoal vignette": "チャコール ビネット",
  "Studio vignette (light)": "スタジオ ビネット（明）",
  "Navy vignette": "ネイビー ビネット",
  "Solid dark": "単色ダーク",
  "Solid light": "単色ライト",
  "Solid black (hologram devices)": "単色ブラック（ホログラム機器向け）",
  "Placement of the GLB scene ITSELF, in metres (avatar ≈ 1.5 m tall) — aligning an arbitrarily-exported room so its floor/scale/facing line up. Scale, X/Y/Z offset, and Y-axis rotation in degrees.":
    "GLB シーン自体の配置（メートル単位、アバターは約 1.5 m）— 任意の形式でエクスポートされたルームの床・スケール・向きを合わせるためのものです。スケール、X/Y/Z オフセット、Y 軸回転（度）。",
  "Room": "ルーム",
  "Where the COMPANION spawns in this scene by default (in metres/degrees), before anyone has hand-placed it in walk mode. Tip: use walk mode's live position readout to find good numbers (or its \"Set as default\" button), then enter them here.":
    "コンパニオンが誰にも手動配置される前に、このシーンでデフォルトでスポーンする位置です（メートル／度）。ヒント：歩行モードのライブ位置表示（または「デフォルトとして設定」ボタン）で良い数値を見つけて、ここに入力してください。",
  "Character spawn": "キャラクタースポーン",
  "default": "デフォルト",
  "Save avatar": "アバターを保存",

  // ── Sessions tab ──────────────────────────────────────────────────────
  "Sessions": "セッション",
  "Lore": "ロア",
  "Every conversation you've had, voice and text — read the transcript, rename, resume, or delete. Reading here never reconnects to xAI.":
    "これまでの音声・テキストの全会話です — トランスクリプトの閲覧、名前の変更、再開、削除ができます。ここでの閲覧が xAI に再接続することはありません。",
  "Search titles, summaries, companions…": "タイトル・要約・コンパニオンを検索…",
  "Filter by companion": "コンパニオンで絞り込み",
  "All companions": "すべてのコンパニオン",
  "Order": "並び順",
  "No sessions yet — start a conversation on the Voice or Chat tab.":
    "まだセッションはありません — ボイスまたはチャットタブで会話を始めましょう。",
  "No sessions match your filters.": "条件に一致するセッションはありません。",
  "Could not load sessions": "セッションを読み込めませんでした",
  "Could not load the transcript": "トランスクリプトを読み込めませんでした",
  "Read transcript": "トランスクリプトを読む",
  "Hide transcript": "トランスクリプトを隠す",
  "Resume this session": "このセッションを再開",
  "Images and videos from this session": "このセッションの画像と動画",
  "Hide files": "ファイルを隠す",
  "No images or videos came out of this session.": "このセッションで生成された画像や動画はありません。",
  "Could not load the session's files": "セッションのファイルを読み込めませんでした",
  "Rename": "名前を変更",
  "Rename failed": "名前の変更に失敗しました",
  "Delete session": "セッションを削除",
  "Delete session \"%s\"? Its messages are removed permanently.":
    "セッション「%s」を削除しますか？ メッセージは完全に削除されます。",
  "Delete session \"%s\"? Its messages are removed permanently. The linked group-call sessions of other companions are kept (they become top-level).":
    "セッション「%s」を削除しますか？ メッセージは完全に削除されます。リンクされた他コンパニオンのグループ通話セッションは残ります（トップレベルに移動します）。",
  "This session has no messages.": "このセッションにはメッセージがありません。",
  "Joined this group call": "このグループ通話に参加",
  "Show more": "もっと見る",
  "Show less": "折りたたむ",
  "Edit summary": "要約を編集",
  "Conversation summary": "会話の要約",
  "This is what the companion remembers of the conversation when it is resumed — edit it to correct or reshape that memory.":
    "再開時にコンパニオンがこの会話について覚えている内容です — 記憶を訂正したり整えたりするには、ここを編集してください。",
  "Summary cannot be empty.": "要約を空にすることはできません。",
  "Could not save the summary": "要約を保存できませんでした",
  "Compact now": "今すぐ圧縮",
  "Compacting…": "圧縮中…",
  "Compaction failed": "圧縮に失敗しました",
  "End the call before compacting it.": "圧縮する前に通話を終了してください。",
  "Condense the older part of this conversation into its summary now, without waiting for the token limit.":
    "トークン上限を待たずに、この会話の古い部分を今すぐ要約にまとめます。",
  "Compact \"%s\" now? The older part of the conversation is condensed into a new summary and the most recent messages are kept word for word. The token count toward the next automatic compaction starts again from zero. Nothing is deleted: the full transcript stays readable here and recallable by the companion. This can take a minute or two.":
    "「%s」を今すぐ圧縮しますか？会話の古い部分を新しい要約にまとめ、直近のメッセージはそのまま残します。次の自動圧縮までのトークン数はゼロから数え直します。何も削除されません。全文のトランスクリプトはここで読め、コンパニオンも呼び出せます。1〜2分かかることがあります。",
  "Nothing to compact yet: there are only the most recent messages, which are kept word for word.":
    "まだ圧縮するものがありません。直近のメッセージしかなく、それらはそのまま残されます。",
  "active": "アクティブ",
  "Immersive view — press Esc or H to exit.": "没入ビュー — Esc または H で終了します。",

  // ── Emotion / gesture labels (avatar_catalog) ─────────────────────────
  "Neutral": "ニュートラル",
  "Happy": "うれしい",
  "Sad": "かなしい",
  "Angry": "おこり",
  "Surprised": "びっくり",
  "Relaxed": "リラックス",
  "Clapping": "拍手",
  "Dance": "ダンス",
  "Goodbye": "バイバイ",
  "Jump": "ジャンプ",
  "Look Around": "きょろきょろ",
  "Sleepy": "ねむい",
  "Thinking": "考え中",
  "Show Full Body": "全身を見せる",
  "Greeting": "あいさつ",
  "Peace Sign": "ピースサイン",
  "Shoot": "指鉄砲",
  "Spin": "スピン",
  "Model Pose": "モデルポーズ",
  "Squats": "スクワット",
  "Backflip": "バク転",
  "Blow Kiss": "投げキッス",
  "Belly Dance": "ベリーダンス",
  "Push-Ups": "腕立て伏せ",
  "Pike Walk": "パイクウォーク",
  // Screen share / capture tools
  "Share your screen — lets the companion take screenshots or record clips of it on request":
    "画面を共有 — コンパニオンがリクエストに応じてスクリーンショットやクリップ録画を撮れるようになります",
  "Stop screen sharing": "画面共有を停止",
  "Recording your screen…": "画面を録画中…",
  "Screen sharing failed: %s": "画面共有に失敗しました: %s",
  // Share popover (screen / camera)
  "Share your screen or camera — lets the companion take a look, grab screenshots or record clips on request":
    "画面またはカメラを共有 — コンパニオンがリクエストに応じて見たり、スクリーンショットやクリップ録画を撮れるようになります",
  "Share your camera — lets the companion take a look on request":
    "カメラを共有 — コンパニオンがリクエストに応じて見られるようになります",
  "Sharing — click to manage or stop": "共有中 — クリックで管理／停止",
  "Sharing failed: %s": "共有に失敗しました: %s",
  "Recording…": "録画中…",
  "Stop sharing": "共有を停止",
  "Screen": "画面",
  "Your companion can take screenshots, read your screen or record short clips of it when you ask. Nothing is captured until they call a tool.":
    "頼めばコンパニオンがスクリーンショットを撮ったり、画面を読んだり、短いクリップを録画したりできます。ツールが呼ばれるまで何もキャプチャされません。",
  "Share screen or camera": "画面またはカメラを共有",
  "Share screen or camera…": "画面またはカメラを共有…",
  "The avatar isn't popped out right now — sharing for mascot mode lives with the popped-out avatar.":
    "アバターは現在ポップアウトされていません — マスコットモードの共有はポップアウトしたアバターと一緒に動きます。",
  "Camera is sharing. Your companion only looks when you ask; each look sends one photo.":
    "カメラを共有中です。コンパニオンが見るのは頼んだときだけで、1 回につき写真 1 枚が送られます。",
  "Show your companion something — a thing you're holding, the room, yourself. They only look when you ask; each look sends one photo.":
    "コンパニオンに何かを見せましょう — 手に持っているもの、部屋、あなた自身。見るのは頼んだときだけで、1 回につき写真 1 枚が送られます。",
  "Which camera to share": "共有するカメラ",
  "Default camera": "既定のカメラ",
  "Switch between front and back camera": "前面／背面カメラを切り替え",
  "Flip": "切替",
  "Runs small face and hand models on this device while the camera is shared, so your companion reacts when you wave, give a thumbs up or down, a peace or OK sign or rock-on, and knows when you step away, come back or yawn. Only short hints reach them — never images, never scores.":
    "カメラ共有中にこの端末内で小さな顔と手のモデルを動かします。手を振る、親指を上げる／下げる、ピース・OK サイン、ロックの手にコンパニオンが反応し、席を外した・戻った・あくび、も把握します。届くのは短いヒントだけ — 画像やスコアは一切送られません。",
  "loading hand model…": "手のモデルを読み込み中…",
  "hand model failed": "手のモデルの読み込みに失敗",
  "hand: %s": "手: %s",
  "Notice presence, expressions & gestures (on this device only)": "在席・表情・ジェスチャーに気づく（この端末内のみ）",
  // Trigger list (info button next to the awareness checkbox)
  "What your companion reacts to": "コンパニオンが反応するもの",
  "Hand signs · hold about a second": "手のサイン · 1 秒ほど保つ",
  "Wave": "手を振る",
  "Waves back; hello or goodbye from context": "振り返します。挨拶か別れかは文脈で判断",
  "Thumbs up": "親指を上げる",
  "Takes it as approval": "賛成と受け取ります",
  "Thumbs down": "親指を下げる",
  "Takes it as disapproval and adjusts": "不賛成と受け取り、方向を変えます",
  "OK sign": "OK サイン",
  "Takes it as 'all good'": "「問題なし」と受け取ります",
  "Peace sign": "ピースサイン",
  "Light, playful reaction": "軽く遊び心のある反応",
  "Rock-on horns": "ロックの手",
  "Matches the energy": "ノリを合わせます",
  "Middle finger": "中指を立てる",
  "Reacts in character": "キャラクターらしく反応します",
  "Presence": "在席",
  "Step away": "席を外す",
  "Knows nobody is there and waits": "不在を把握して待ちます",
  "Come back": "戻ってくる",
  "A short greeting": "短い挨拶",
  "Wave, then leave": "手を振ってから離れる",
  "Treats it as goodbye": "お別れとして扱います",
  "Tiredness": "疲れ",
  "Yawn": "あくび",
  "One soft remark, rarely": "まれに、やさしく一言だけ",
  "A held sign fires once. Release it and pause before repeating it. Only short notes reach your companion, never images.":
    "保ったサインは 1 回だけ反応します。繰り返すには一度手を下ろして間を置いてください。コンパニオンに届くのは短いメモだけで、画像は送られません。",
  "Loading face model…": "顔モデルを読み込み中…",
  "Awareness failed: %s": "認識に失敗しました: %s",
  "you're here, facing the screen": "在席・画面を向いています",
  "you're here": "在席",
  "nobody in frame": "誰も映っていません",
  "Watching: %s · last noticed: %s": "認識中: %s · 直近: %s",
  "Watching: %s": "認識中: %s",
  "Stop camera": "カメラを停止",
  "Start camera": "カメラを開始",
  "Share screen": "画面を共有",
  "Camera is also sharing.": "カメラも共有中です。",
  "Screen is also sharing.": "画面も共有中です。",
  "Stop it": "停止する",

  // ── Companion tool flags ────────────────────────────────────────────────
  "Task delegation (delegate_task)": "タスク委任（delegate_task）",
  "Multi-agent delegation (pricier)": "マルチエージェント委任（高コスト）",
  "Local computer tasks (Grok Build CLI — real files & shell)":
    "ローカルコンピュータタスク（Grok Build CLI — 実際のファイルとシェル操作）",
  "Minecraft bot (directs the game sidecar — see the Games tab)":
    "Minecraft ボット（ゲームサイドカーに指示 — ゲームタブ参照）",

  // ── Memories editor ─────────────────────────────────────────────────────
  "New memory": "新しいメモリ",
  "Edit memory": "メモリを編集",
  "Add memory": "メモリを追加",
  "A durable fact worth remembering, e.g. \"My favourite colour is teal.\"":
    "記憶しておきたい事実。例：「好きな色はティール。」",
  "Keywords (what recall searches against)": "キーワード（リコール検索の対象）",
  "Scope": "スコープ",
  "Recall — searched when relevant": "リコール — 関連するときに検索されます",
  "Core — always in the prompt": "コア — 常にプロンプトに含まれます",
  "Tags (comma-separated)": "タグ（カンマ区切り）",
  "preferences, colors": "好み, 色",

  // ── Avatar manager extras ───────────────────────────────────────────────
  "Create copy": "コピーを作成",
  "Name for the copy (also names the pack folder)":
    "コピーの名前（パックフォルダ名にもなります）",
  "Gesture name the model calls — lowercase letters, digits and underscores, starting with a letter (e.g. wave_hello, test_1).":
    "モデルが呼び出すジェスチャー名 — 小文字の英字・数字・アンダースコアのみ、先頭は英字（例: wave_hello, test_1）。",
  "Gesture name the model calls — lowercase letters, digits and underscores, starting with a letter (e.g. dance_together).":
    "モデルが呼び出すジェスチャー名 — 小文字の英字・数字・アンダースコアのみ、先頭は英字（例: dance_together）。",

  // ── Settings: multi-agent delegation ────────────────────────────────────
  "Multi-agent model": "マルチエージェントモデル",
  "xAI multi-agent model used when delegate_task is called with multi_agent=true. Several agents collaborate on the query and a leader synthesizes — every sub-agent bills tokens, so this is markedly more expensive than a standard call. Beta on xAI's side; custom function tools are NOT supported there.":
    "delegate_task が multi_agent=true で呼ばれたときに使う xAI マルチエージェントモデル。複数のエージェントが協力して取り組み、リーダーが結果をまとめます — サブエージェントごとにトークンが課金されるため、通常の呼び出しよりかなり高価です。xAI 側でベータ版のため、カスタム関数ツールは利用できません。",
  "Multi-agent effort": "マルチエージェント推論エフォート",
  "reasoning.effort sent on multi-agent delegations — xAI maps low/medium to 4 collaborating agents, high/xhigh to 16.":
    "マルチエージェント委任で送られる reasoning.effort — xAI は low/medium を 4 エージェント、high/xhigh を 16 エージェントに割り当てます。",
  "Low (4 agents)": "低（4 エージェント）",
  "Medium (4 agents)": "中（4 エージェント）",
  "High (16 agents)": "高（16 エージェント）",
  "X-High (16 agents)": "最高（16 エージェント）",

  // ── Settings: local computer tasks ──────────────────────────────────────
  "Local computer tasks": "ローカルコンピュータタスク",
  "Companions with \"Local computer tasks\" enabled (per companion, on the Companions tab) can hand real work to the Grok Build CLI running on this machine: it creates and edits files, writes code and runs shell commands — for real, with no confirmation prompts — inside the working folder below. Leave the folder empty for a dedicated workspace inside Rexclaw's data folder; point it at a project only if you want companions working in it directly. Requires the Grok Build CLI (docs.x.ai/build) installed on this machine — without it the tool simply isn't offered. Billing: if you signed into the Grok CLI, tasks bill that login; otherwise your Rexclaw API key is used.":
    "「ローカルコンピュータタスク」を有効にしたコンパニオン（Companions タブでコンパニオンごとに設定）は、このマシンで動く Grok Build CLI に実際の作業を任せられます。ファイルの作成・編集、コードの記述、シェルコマンドの実行を、下の作業フォルダの中で確認プロンプトなしに本当に実行します。フォルダを空欄にすると Rexclaw のデータフォルダ内の専用ワークスペースが使われます。プロジェクトを直接触らせたい場合のみ、そのフォルダを指定してください。このマシンに Grok Build CLI（docs.x.ai/build）がインストールされている必要があり、なければツール自体が提供されません。課金：Grok CLI にサインインしていればそのアカウントに、していなければ Rexclaw の API キーに課金されます。",
  "Working folder (empty = data/workspace)": "作業フォルダ（空欄 = data/workspace）",
  "e.g. C:\\Users\\me\\rexclaw-workspace": "例: C:\\Users\\me\\rexclaw-workspace",
  "Grok Build CLI": "Grok Build CLI",
  "Detected: %s": "検出: %s",
  "Not found on this machine — install it, then reopen Settings to re-check":
    "このマシンには見つかりません — インストール後、設定を開き直すと再チェックされます",

  // ── Games tab (Minecraft) ───────────────────────────────────────────────
  "Minecraft bot": "Minecraft ボット",
  "Companions with \"Minecraft bot\" enabled (per companion, on the Companions tab) can direct a bot that joins your Minecraft world as its own player and plays for real: mining, crafting, building, following you. You give orders by voice, and your companion reacts to what happens in the world. Each command is planned by the cheaper standard model below; for big jobs (long multi-stage tasks, elaborate builds) your companion can forward a command to the hard-task model instead, which thinks much longer before acting. The bot executes model-generated scripts in your world, so use it on your own or trusted servers only.":
    "「Minecraft ボット」を有効にしたコンパニオン（Companions タブでコンパニオンごとに設定）は、あなたの Minecraft ワールドに独立したプレイヤーとして参加するボットに指示を出せます。採掘・クラフト・建築・追従を実際にプレイし、指示は声で出せて、ワールドで起きたことにはコンパニオンが反応します。各コマンドは下の安価な標準モデルが計画しますが、大きな仕事（長い多段タスクや凝った建築）はコンパニオンがハードタスク用モデルへ転送でき、そちらは行動前にじっくり考えます。ボットはモデルが生成したスクリプトをワールド内で実行するため、自分のワールドか信頼できるサーバーでのみ使用してください。",
  "Setup: start your world and open it to LAN (Minecraft prints a new port every time), then run the sidecar on the same machine as the game (first time: npm install). Set --username to your companion's name so the character in the world is them, not a stranger:":
    "セットアップ：ワールドを起動して LAN に公開し（Minecraft は毎回新しいポートを表示します）、ゲームと同じマシンでサイドカーを実行します（初回は npm install）。--username にはコンパニオンの名前を設定してください — ワールド内のキャラクターが見知らぬ誰かではなく、そのコンパニオン本人になります：",
  "Requirements: Node 18+, and a Minecraft Java Edition world on a version mineflayer supports (currently up to 1.21.11).":
    "必要環境：Node 18 以上、および mineflayer が対応するバージョンの Minecraft Java Edition ワールド（現在 1.21.11 まで）。",
  "Bot brain model (empty = %s)": "ボットの頭脳モデル（空欄 = %s）",
  "Bot brain model": "ボットの頭脳モデル",
  "the model's name on that server": "そのサーバーでのモデル名",
  "Hard-task model for big jobs (empty = %s)": "大きな仕事用のハードタスクモデル（空欄 = %s）",
  "Hard-task model for big jobs (empty = disabled)":
    "大きな仕事用のハードタスクモデル（空欄 = 無効）",
  "Bot brain connection": "ボットの頭脳の接続",
  "xAI (Grok)": "xAI（Grok）",
  "The xAI key from Settings, or an OpenAI-compatible or Claude connection from Settings → Models & providers (its URL and key).":
    "設定の xAI キー、または 設定 → モデルとプロバイダー の OpenAI 互換・Claude 接続（その URL とキー）。",
  "Your in-game username (the bot prioritizes you)":
    "あなたのゲーム内ユーザー名（ボットが優先します）",
  "e.g. Jonny": "例: Jonny",
  "Sidecar": "サイドカー",
  "Connected — the tool is live in new calls":
    "接続済み — 新しい通話でツールが有効になります",
  "Not connected — start it with node index.js in the game_integrations/minecraft folder, then reopen this tab":
    "未接続 — game_integrations/minecraft フォルダで node index.js を実行してから、このタブを開き直してください",

  // ── Voice / text / transcript extras ────────────────────────────────────
  "Enter VR": "VR に入る",
  "Enter VR — opens this companion in a VR-capable browser window":
    "VR に入る — このコンパニオンを VR 対応ブラウザのウィンドウで開きます",
  "Companion to chat with": "チャットするコンパニオン",
  "\"%s\" is too large (max 48 MB).": "「%s」は大きすぎます（最大 48 MB）。",
  "Upload failed: %s": "アップロードに失敗しました: %s",
  "Attach files": "ファイルを添付",
  "Remote MCP server unreachable — continuing without MCP tools.":
    "リモート MCP サーバーに接続できません — MCP ツールなしで続行します。",

  // ── Heartbeats ────────────────────────────────────────────────────────
  "Allow the companion's other tools during this heartbeat":
    "このハートビート中にコンパニオンの他のツールを許可する",
  "Gives this tick the companion's ordinary tools — memory, pictures, delegated tasks, Minecraft, MCP servers. Off by default: a background tick writes a diary entry or texts someone, and a companion with an idle tool belt and nothing left to do tends to fill the turn with pointless calls. Companion texting below is separate and unaffected.":
    "このティックでコンパニオンの通常のツール（メモリ、画像、委任タスク、Minecraft、MCP サーバー）を使えるようにします。既定はオフです。バックグラウンドのティックは日記を書いたり誰かにメッセージを送ったりするもので、手持ち無沙汰なツールを抱えたコンパニオンは、意味のない呼び出しでターンを埋めがちだからです。下のコンパニオン間メッセージは別扱いで、この設定の影響を受けません。",
  "Hide this heartbeat's entries behind an accordion in the transcript":
    "このハートビートの書き込みをトランスクリプトで折りたたむ",
  "Folds everything a silent tick writes (a diary entry, a texting exchange) behind one collapsed row named after this heartbeat in the chat and voice transcripts. Keeps the conversation short and lets you choose whether to read it. Toggling it restyles past ticks too; call-mode ticks are never folded.":
    "サイレントティックが書いたもの（日記、コンパニオン間のメッセージ）を、チャットとボイスのトランスクリプトでこのハートビート名の折りたたみ行にまとめます。会話が長くならず、読むかどうかを自分で選べます。切り替えると過去のティックにも反映されます。通話モードのティックは折りたたまれません。",
  "Written by a scheduled heartbeat while you were away. Click to show or hide it.":
    "留守中にハートビートが書き込んだ内容です。クリックで表示・非表示を切り替えます。",
  "A text from another companion and the reply. Click to show or hide it.":
    "他のコンパニオンからのメッセージとその返信です。クリックで表示・非表示を切り替えます。",
  "Text from %s": "%s からのメッセージ",
  "Fires": "発火条件",
  "On a schedule": "スケジュールで",
  "After the user has been quiet for": "ユーザーが一定時間静かなとき",
  "On a schedule: fires every interval from 'Next run'. After the user has been quiet: fires once when you have not written to this companion for one interval (in the latest conversation), then not again until you speak. Quiet-period heartbeats are always silent.":
    "スケジュール: 「次回実行」から間隔ごとに発火します。ユーザーが静かなとき: 最新の会話でこのコンパニオンに一定時間メッセージを送っていないと一度だけ発火し、次にあなたが話しかけるまで再発火しません。この種類のハートビートは常にサイレントです。",
  "Quiet for": "静かな時間",
  "How long the user has to be quiet before this heartbeat fires.":
    "このハートビートが発火するまでにユーザーが静かでいる必要のある時間です。",
  "after %s %s of quiet": "%s %s 静かなあと",
  "waiting for quiet": "静かになるのを待機中",
  "Notify me when it runs (desktop app)": "実行時に通知する（デスクトップアプリ）",
  "Raise a desktop notification when a silent run of this heartbeat writes something; clicking it opens the chat. Needs 'Desktop notifications for heartbeats' in Settings and the desktop app. Meant for heartbeats that write to you, not for a diary.":
    "このハートビートのサイレント実行が何かを書き込んだときにデスクトップ通知を出します。クリックするとチャットが開きます。設定の「ハートビートのデスクトップ通知」とデスクトップアプリが必要です。日記ではなく、あなた宛てに書くハートビート向けです。",
  "Desktop notifications for heartbeats": "ハートビートのデスクトップ通知",
  "Send a test notification": "テスト通知を送る",
  "Raises a sample notification right now, so you can check that your system shows them for this app.":
    "今すぐサンプル通知を出して、システムがこのアプリの通知を表示するか確認できます。",
  "Notifications are working. A companion's message will look like this.":
    "通知は動作しています。コンパニオンからのメッセージはこのように表示されます。",
  "This system reports no notification support.": "このシステムは通知に対応していないと報告しています。",
  "Heartbeats that write to you can raise a system notification when they run, even while Rexclaw sits in the tray or behind other windows. Clicking it opens the chat with that companion. Only heartbeats with 'Notify me when it runs' ticked take part, so a diary stays quiet. Requires notifications to be on for Rexclaw (Windows: Settings › System › Notifications; macOS: System Settings › Notifications) and Do Not Disturb off.":
    "あなた宛てに書くハートビートは、Rexclaw がトレイや他のウィンドウの後ろにあっても、実行時にシステム通知を出せます。クリックするとそのコンパニオンとのチャットが開きます。「実行時に通知する」にチェックしたハートビートだけが対象なので、日記は静かなままです。Rexclaw の通知がオンになっている必要があります（Windows: 設定 › システム › 通知、macOS: システム設定 › 通知）。応答不可（集中モード）はオフにしてください。",
  "Heartbeats": "ハートビート",
  "Heartbeats can be added after the companion is saved.":
    "ハートビートはコンパニオンを保存した後に追加できます。",
  "Scheduled prompts that keep the companion living between your conversations — write a diary entry, check on something, or call you. Silent heartbeats run in the background while the app is open; call heartbeats ring you like the wake word does. Schedules missed while the app was closed never run on their own: they wait here, past due, for your decision.":
    "会話と会話のあいだもコンパニオンが生き続けるための定期プロンプトです — 日記を書いたり、何かを確認したり、あなたに通話をかけたり。サイレントのハートビートはアプリ起動中にバックグラウンドで実行され、通話ハートビートはウェイクワードと同じようにあなたを呼び出します。アプリを閉じている間に期限が来た予定は勝手には実行されず、期限超過としてあなたの判断を待ちます。",
  "Could not load heartbeats": "ハートビートを読み込めませんでした",
  "Could not save the heartbeat": "ハートビートを保存できませんでした",
  "Delete the heartbeat '%s'?": "ハートビート「%s」を削除しますか？",
  "(unnamed)": "（名称未設定）",
  "Could not resolve the heartbeat": "ハートビートを処理できませんでした",
  "Could not resolve the heartbeats": "ハートビートを処理できませんでした",
  "Execute every past-due heartbeat of %s once, now? Each run is a real model turn.":
    "%s の期限超過ハートビートをすべて今すぐ 1 回ずつ実行しますか？各実行は実際のモデル呼び出しです。",
  "Execute every past-due heartbeat of every companion once, now? Each run is a real model turn.":
    "すべてのコンパニオンの期限超過ハートビートを今すぐ 1 回ずつ実行しますか？各実行は実際のモデル呼び出しです。",
  "Executed %s past-due heartbeats.": "%s 件の期限超過ハートビートを実行しました。",
  "Deferred %s past-due heartbeats to their next slot.":
    "%s 件の期限超過ハートビートを次回の予定時刻に延期しました。",
  "%s past-due heartbeats pending your decision.":
    "%s 件の期限超過ハートビートがあなたの判断を待っています。",
  "Heartbeat schedules that came due while the app was closed. They never run on their own — decide here in one go, or per heartbeat inside each companion's editor.":
    "アプリを閉じている間に期限が来たハートビートです。勝手に実行されることはありません — ここで一括で、または各コンパニオンの編集画面で個別に判断してください。",
  "Execute all": "すべて実行",
  "Working through the past-due heartbeats — each execution is a full model turn, this can take a while…":
    "期限超過のハートビートを処理中です — 各実行はモデルの 1 ターンなので、しばらくかかることがあります…",
  "Defer all": "すべて延期",
  "Run every past-due heartbeat once now, then reschedule from now":
    "期限超過のハートビートをすべて今すぐ 1 回実行し、今を起点に再スケジュールします",
  "Skip the missed runs — each heartbeat waits for its next scheduled slot":
    "逃した実行はスキップし、各ハートビートは次回の予定時刻を待ちます",
  "Execute all past due": "期限超過をすべて実行",
  "Defer all past due": "期限超過をすべて延期",
  "Add heartbeat": "ハートビートを追加",
  "e.g. 'Afternoon diary'": "例：「午後の日記」",
  "How often the heartbeat fires while the app is running. Also drives the default 'Next run' (now + interval) until you pick a date yourself.":
    "アプリ起動中にハートビートが発火する頻度です。日時を自分で指定するまでは、既定の「次回実行」（現在 + 間隔）もこれで決まります。",
  "Every": "間隔",
  "minutes": "分",
  "hours": "時間",
  "days": "日",
  "Silent: the prompt runs as a background text turn — you find the result in the session later. Call the user first: the companion starts a voice call with you, carries out the prompt, and speaks first (needs the app open).":
    "サイレント：プロンプトはバックグラウンドのテキストターンとして実行され、結果は後からセッションで確認できます。先に通話をかける：コンパニオンがあなたに音声通話を開始し、プロンプトを実行してから先に話しかけます（アプリが開いている必要があります）。",
  "Mode": "モード",
  "Silent (background)": "サイレント（バックグラウンド）",
  "Call the user first": "先にユーザーへ通話をかける",
  "What the companion should do each time the heartbeat fires. It always knows the current time, when this heartbeat last ran, and when you last actually talked — so prompts like 'if it's been more than 4 hours since our last call, write a diary entry about what you've been doing' work.":
    "ハートビートが発火するたびにコンパニオンがすべきことです。現在時刻、このハートビートの前回実行時刻、あなたと最後に実際に話した時刻を常に把握しているので、「前回の通話から 4 時間以上経っていたら、その間何をしていたか日記を書いて」のようなプロンプトが機能します。",
  "Prompt": "プロンプト",
  "e.g. 'Bring your diary up to date: one date-stamped entry per 4-hour span since our last conversation ended (under 4 hours = one short entry noting it's only been a little while). Decide what you were doing from your job, hobbies and recent conversations; weekends and time off count, and entries may continue the previous span. Sleeping hours are 23:00–07:00: just log \"sleeping\" for those spans. This records your life between calls, so you know what you've been up to when the user comes back.'":
    "例：「日記を最新の状態にして：前回の会話が終わってからの 4 時間ごとに、日時付きのエントリを 1 件ずつ、順番に（4 時間未満なら、まだ少ししか経っていないと添えた短い 1 件だけ）。何をしていたかは仕事・趣味・最近の会話から決めて。週末や休みも考慮し、前の枠の続きでも構わない。睡眠時間は 23:00〜07:00 で、その枠は『就寝中』とだけ記録して。これは通話と通話のあいだの生活の記録で、ユーザーが戻ってきたとき何をしていたか話せるようにするためのもの。」",
  "Where each run lands. 'Latest conversation' resolves fresh every run to the same session 'Resume last' picks up — so the companion's diary entries are right there next time you resume. 'One ongoing heartbeat session' keeps a workspace of its own. 'A session I pick' always runs in one specific conversation. 'Own session per run' is a throwaway, ended after each run.":
    "毎回の実行がどこに記録されるか。「最新の会話」は実行のたびに「前回の続きを再開」が選ぶのと同じセッションを解決するので、次に再開したときコンパニオンの日記がそこにあります。「継続ハートビートセッション」は専用ワークスペースを維持します。「自分で選んだセッション」は常に特定の会話で実行します。「実行ごとに専用セッション」は使い捨てで、実行後に終了します。",
  "Runs in": "実行先",
  "Latest conversation (the 'Resume last' target)": "最新の会話（「前回の続きを再開」の対象）",
  "One ongoing heartbeat session": "継続ハートビートセッション",
  "A session I pick": "自分で選んだセッション",
  "Own session per run (throwaway)": "実行ごとに専用セッション（使い捨て）",
  "When the next run is due, in your local time. Maintained automatically — after each run it advances to last run + interval — and you can set it directly to schedule the next run yourself (e.g. tomorrow 09:00). Setting it in the past makes a silent heartbeat run on the next scheduler tick.":
    "次回実行の予定時刻（ローカル時間）。自動で維持され、実行のたびに前回実行 + 間隔へ進みます — 直接指定して次回を任意にスケジュールすることもできます（例：明日 09:00）。過去の時刻に設定すると、サイレントのハートビートは次のスケジューラーティックで実行されます。",
  "Next run": "次回実行",
  "The conversation this heartbeat always runs in — its turns land in that thread.":
    "このハートビートが常に実行される会話 — そのスレッドにターンが追加されます。",
  "(pick a session…)": "（セッションを選択…）",
  "Session": "セッション",
  "The heartbeat only fires while active: at the 'Next run' date, then every interval.":
    "ハートビートは有効な間だけ発火します：「次回実行」の日時に、以降は間隔ごとに。",
  "Allow companion texting during this heartbeat": "このハートビート中のコンパニオンテキストを許可",
  "Lets this heartbeat's own tick text another companion (text_companion) and get their reply back, up to the exchange limit below. Off by default — a diary-style heartbeat, for example, usually doesn't need it.":
    "このハートビートの実行中に、別のコンパニオンにテキストを送って返信を受け取れるようにします（text_companion）。回数は下のやり取りの上限まで。デフォルトはオフ — 例えば日記のようなハートビートには通常不要です。",
  "Exchange limit": "やり取りの上限",
  "The most exchanges this tick may have with another companion. The companion decides whether to use any of it at all, and doesn't have to reach the limit.":
    "この実行が別のコンパニオンと行える最大のやり取り回数です。使うかどうかはコンパニオン自身が判断し、上限まで使う必要はありません。",
  "texting up to %s": "テキスト上限%s回",
  "own session per run": "実行ごとに専用セッション",
  "latest conversation": "最新の会話",
  "chosen session": "選んだセッション",
  "Save heartbeat": "ハートビートを保存",
  "No heartbeats yet.": "ハートビートはまだありません。",
  "every %s %s": "%s %sごと",
  "calls you": "あなたに通話",
  "silent": "サイレント",
  "ongoing session": "継続セッション",
  "Last run failed:": "前回の実行が失敗しました:",
  "Last run:": "前回の実行:",
  "next:": "次回:",
  "inactive": "無効",
  "last:": "前回:",
  "This heartbeat came due while the app was closed (or nobody answered its call). It won't run until you decide.":
    "このハートビートはアプリを閉じている間に期限が来ました（または通話に誰も応答しませんでした）。あなたが判断するまで実行されません。",
  "past due": "期限超過",
  "Run it once now, then reschedule from now": "今すぐ 1 回実行し、今を起点に再スケジュールします",
  "Skip the missed run — wait for the next scheduled slot":
    "逃した実行はスキップし、次回の予定時刻を待ちます",
  "Execute": "実行",
  "Defer": "延期",
  "(current session #%s)": "（現在のセッション #%s）",
  "Scheduled prompts — imported inactive, ready to review and switch on":
    "定期プロンプト — 無効状態でインポートされ、確認してから有効化できます",

  // ── List sorting (Companions / Avatars) ───────────────────────────────
  "List order": "並び順",
  "Sort: name": "並び順: 名前",
  "Sort: created": "並び順: 作成順",

  // ── Avatar editor: collapsible list rows ──────────────────────────────
  "partner:": "パートナー:",
  "Revert this entry to how it was when you opened it (a new entry is removed)":
    "このエントリを開いた時点の状態に戻します（新規エントリは削除されます）",
  "Keep the edits in the draft — 'Save avatar' writes them to the pack":
    "編集は下書きに保持されます — 「アバターを保存」でパックに書き込まれます",

  // ── Companion delete: linked-avatar tickbox ───────────────────────────
  "Also delete its avatar '%s' (pack files included)":
    "アバター「%s」も削除する（パックのファイルを含む）",
  "Avatar kept: %s": "アバターは残されました: %s",

  // ── Row-draft flush on main Save ──────────────────────────────────────
  "The open heartbeat draft is incomplete — finish it or cancel it, then save again.":
    "開いているハートビートの下書きが未完成です — 完成させるかキャンセルしてから、もう一度保存してください。",
  "The open story draft is incomplete — finish it or cancel it, then save again.":
    "開いているストーリーの下書きが未完成です — 完成させるかキャンセルしてから、もう一度保存してください。",
  "The open MCP connection draft is incomplete — finish it or cancel it, then save again.":
    "開いている MCP 接続の下書きが未完成です — 完成させるかキャンセルしてから、もう一度保存してください。",

  // ── Avatar editor: motion & built-in gesture whitelist ────────────────
  "Motion & gestures": "モーションとジェスチャー",
  "Restrict built-in gestures to a whitelist": "組み込みジェスチャーをホワイトリストに限定する",
  "Offer the companion only the built-in gestures picked below (its play_gesture tool and the gesture panel). With nothing picked, built-in gestures are off entirely and only this avatar's custom gestures remain.":
    "下で選んだ組み込みジェスチャーだけをコンパニオンに提供します（play_gesture ツールとジェスチャーパネルの両方）。何も選ばない場合、組み込みジェスチャーは完全にオフになり、このアバターのカスタムジェスチャーだけが残ります。",
  "Nothing picked — built-in gestures are off for this avatar.":
    "何も選ばれていません — このアバターでは組み込みジェスチャーはオフです。",
  "Add a built-in gesture…": "組み込みジェスチャーを追加…",
  "All built-in gestures added": "組み込みジェスチャーはすべて追加済みです",

  // ── Settings: TypeSafe (Jev) ──────────────────────────────────────────
  "TypeSafe (Jev)": "TypeSafe（Jev）",
  "Jev is a judgment model: it answers a pile of small questions about one line at once, in a fraction of a second. Features that have to read something while it is still happening use it, and share this one key. Usage is billed by TypeSafe. Reads English best.":
    "Jev は判断モデルです。1 つの文についての細かい質問をまとめて、ごく短時間で一度に答えます。進行中の内容をその場で読み取る必要がある機能がこれを使い、このキーを共有します。利用料金は TypeSafe から請求されます。英語の読み取りが最も得意です。",
  "TypeSafe API key": "TypeSafe API キー",
  "Jev model": "Jev モデル",
  "Live memory recall (experimental)": "会話中の記憶想起（実験的）",
  "An inserted note can slightly delay the reply. You can read the exact note in History → Sessions.":
    "メモが追加されると、返答が少し遅れる場合があります。追加されたメモの全文は「履歴 → セッション」で確認できます。",
  "Live memory cooldown (seconds)": "記憶想起のクールダウン（秒）",
  "Pause memory lookups after a note is admitted. Default: 60 seconds. Set to 0 for no pause; either way the same memory waits two weeks before it can come up again. Start a new call after changing this setting.":
    "記憶のメモが応答に渡された後、検索を一時停止します。初期値は60秒です。0にすると待機時間がなくなりますが、いずれの場合も同じ記憶が再び使われるまでには2週間の間隔が空きます。変更後は新しい通話を開始してください。",
  "Live memory cooldown must be a whole number from 0 to 3600 seconds.": "記憶想起のクールダウンは0〜3600秒の整数で指定してください。",
  "Invalid live memory mode.": "記憶想起の設定値が不正です。",
  "Recall a shared joke, distinctive event or familiar habit while you speak. Uses the Jev model above and requires memory tools on the companion. Available in voice calls with one companion; start a new call after changing this setting.":
    "あなたが話している間に、共通の冗談、印象的な出来事、馴染みの習慣を思い出します。上記の Jev モデルを使用し、コンパニオンの記憶ツールを有効にする必要があります。1 対 1 の音声通話で利用できます。設定を変更した後は、新しく通話を開始してください。",
  "jev-latest is TypeSafe's alias for their newest Jev release. Enter a version such as jev-1.13.0 to stay on it when a new one comes out. Test shows the version the name resolves to.":
    "jev-latest は TypeSafe の最新 Jev リリースを指すエイリアスです。jev-1.13.0 のようにバージョンを入力すると、新しいリリースが出てもそのバージョンを使い続けます。テストで、その名前が実際にどのバージョンを指すかを確認できます。",
  "Test": "テスト",
  "first call": "初回",
  "then": "以降",
  "Used by: Expressive face and head, Automated background gestures, Live memory recall, and picking who speaks next in a group call. Background gestures and group-call turn selection fall back to the turn director model without a key, and without an xAI key either to the quick model of your companion's voice setup brain.":
    "使用する機能：豊かな表情と頭の動き、自動背景ジェスチャー、会話中の記憶想起、グループ通話での次の話者の選択。キーがない場合、自動背景ジェスチャーと話者の選択にはターンディレクターモデルを使用し、xAI キーもない場合はコンパニオンの音声セットアップのブレインのクイックモデルを使用します。",

  // ── Settings / mascot: background avatar motion ───────────────────────
  "Background Avatar Motion": "アバターの自動モーション",
  "Extra body language on top of the avatar's own gesture set, picked up in the background.":
    "アバター本来のジェスチャーに加えて、自動で拾われる body language です。",
  "Automated background gestures while speaking (experimental)":
    "発話中の自動ジェスチャー（実験的）",
  "Your companion gestures along with what they're saying: a bow for thanks, a shrug for \"oh well\". Needs a motion clip library to pick from.":
    "コンパニオンが話している内容に合わせてジェスチャーします。お礼にはお辞儀、「まあいいか」には肩をすくめる、といった具合です。選択元となるモーションライブラリが必要です。",
  "Gestures along with what they're saying. Matched per sentence by the director model, so it adds a little usage.":
    "話している内容に合わせてジェスチャーします。文ごとにディレクターモデルが選ぶため、利用量が少し増えます。",
  // Who picks the clip: Jev when a TypeSafe key is set, else the director
  // model. No setting — the key decides.
  "Jev reads each sentence against the clip library and answers in about a quarter of a second, so the gesture is ready well before the line is spoken. Sent for each line: the sentence itself and your companion's \"## Identity\" and \"## Personality\" sections.":
    "Jev は各文をクリップライブラリと照らし合わせ、約 0.25 秒で答えます。そのため、その文が読み上げられるよりも十分前にジェスチャーが用意されます。文ごとに送られるのは、その文自体と、コンパニオンの「## Identity」「## Personality」セクションだけです。",
  "The turn director model set below reads each sentence against the clip library (without an xAI key: the quick model of your companion's voice setup brain). Set a TypeSafe API key above and Jev does it instead — faster, cheaper and a better match.":
    "下で設定するターンディレクターモデルが、各文をクリップライブラリと照らし合わせます（xAI キーがない場合は、コンパニオンの音声セットアップのブレインのクイックモデル）。上で TypeSafe API キーを設定すると、代わりに Jev が担当します。より速く、より安く、より適切に選びます。",
  "Expressive face and head while speaking (experimental - requires Jev)":
    "発話中の表情と頭の動き（実験的・Jev が必要）",
  "Your companion's face and head follow what each sentence means, and what you say to them as you say it: a smile, a frown, a nod on a yes, a shake on a no, a look away while they think. Built from the avatar's own expressions, so any VRM works. Their own big emotions still play on top. Needs a TypeSafe API key for Jev, set above. Applies from the next call.":
    "コンパニオンの表情と頭の動きが、各文の意味と、話している最中のあなたの言葉に反応します。微笑む、眉をひそめる、「はい」でうなずく、「いいえ」で首を振る、考えている間は視線を外す、といった具合です。アバター自身の表情から組み立てるため、どの VRM でも動作します。コンパニオン自身の大きな感情表現はその上に重ねて再生されます。上で設定する Jev 用の TypeSafe API キーが必要です。次回の通話から適用されます。",
  "Sent to TypeSafe for each line: the sentence itself (yours as text, about once a second while you speak), the last two messages of the conversation, and your companion's \"## Identity\" and \"## Personality\" sections, each up to the next heading. Nothing else goes: not their memories, their lore, the rest of their prompt, or your voice. Those two sections are what set how much a feeling shows and how an ambiguous line reads in character, so keep your companion's prompt in the standard section format. A prompt without those headings falls back to its first 1200 characters, whatever they happen to be.":
    "文ごとに TypeSafe へ送られるのは、その文自体（あなたの発言は、話している間およそ 1 秒ごとにテキストで）、直前 2 件のメッセージ、そしてコンパニオンの「## Identity」「## Personality」セクション（それぞれ次の見出しまで）です。それ以外は送られません。メモリ、ロア、プロンプトの残りの部分、あなたの音声はいずれも送られません。この 2 つのセクションが、感情のあらわれ方と、曖昧な文がそのキャラクターらしくどう読まれるかを決めます。そのため、コンパニオンのプロンプトは標準のセクション形式で書いてください。見出しがないプロンプトの場合は、先頭 1200 文字がそのまま使われます。",
  "Small movements while they stand quietly: a weight shift, folded arms, a touch of their hair.":
    "静かに立っている間の小さな動き：重心を移す、腕を組む、髪に触れる。",
  "Idle fidgets": "待機中の小さな動き",
  "Small movements while your companion stands there quietly: a shift of weight, folded arms, a touch of their hair.":
    "コンパニオンが静かに立っている間の小さな動きです。重心を移す、腕を組む、髪に触れる、といったものです。",
  "Fidget every (seconds, average)": "動きの間隔（秒・平均）",
  "An average, not a metronome. The real gap varies either side of it so the movements never fall into a rhythm.":
    "あくまで平均で、メトロノームではありません。実際の間隔はこの前後で変化するため、動きが一定のリズムになることはありません。",
  "No motion library installed, so these have nothing to play yet.":
    "モーションライブラリが未導入のため、再生できるものがまだありません。",

  // ── Credits dialog ────────────────────────────────────────────────────
  "Credits": "クレジット",
  "Rexclaw stands on a lot of other people's work. Licences are as stated by each project; the full text ships with the dependencies themselves.":
    "Rexclaw は多くの方々の成果の上に成り立っています。ライセンスは各プロジェクトの表記に従い、全文は依存関係そのものに同梱されています。",
  "Avatars & animation": "アバターとアニメーション",
  "Motion library": "モーションライブラリ",
  "Voice activation": "音声起動",
  "Minecraft sidecar": "Minecraft サイドカー",
  "pixiv Inc. The built-in gesture clips. Commercial use permitted with credit.":
    "pixiv Inc.。組み込みのジェスチャークリップ。クレジット表記により商用利用可。",
  "MIT. Plays the avatars and their animations.":
    "MIT。アバターとそのアニメーションを再生します。",
  "MIT. The 3D renderer behind every avatar view.":
    "MIT。すべてのアバター表示を支える 3D レンダラー。",
  "MIT, S-Lab, Nanyang Technological University. Source of the speaking gestures and idle fidgets, converted to VRMA by the tool in tools/motion.":
    "MIT、S-Lab, Nanyang Technological University。発話ジェスチャーと待機中の小さな動きの出典。tools/motion のツールで VRMA に変換しています。",
  "Apache-2.0. The offline speech models that listen for wake phrases.":
    "Apache-2.0。ウェイクフレーズを聞き取るオフライン音声モデル。",
  "CC0. The recorded beds heartbeat-drone, void-drone (bassimat), relaxation-pads, angelic-pad (PhonZz) and emanation (Kronek9), and the music space-pad and cosmic-glow (Andrewkn). Sources in assets/audio/beds/CREDITS.md.":
    "CC0。録音ベッドの heartbeat-drone、void-drone（bassimat）、relaxation-pads、angelic-pad（PhonZz）、emanation（Kronek9）と、音楽の space-pad、cosmic-glow（Andrewkn）。出典は assets/audio/beds/CREDITS.md に記載。",
  "Rexmaw Raids music": "Rexmaw Raids の音楽",
  "CC0. The day sailing music, looped.":
    "CC0。昼の航海の音楽（ループ）。",
  "CC0. The night sailing music, looped.":
    "CC0。夜の航海の音楽（ループ）。",
  "CC BY 3.0, Matthew Pablo (matthewpablo.com). The battle music (the composer's loop).":
    "CC BY 3.0、Matthew Pablo（matthewpablo.com）。戦闘の音楽（作曲者によるループ版）。",
  "CC BY 3.0, Matthew Pablo (matthewpablo.com). The boss music (the Blackmoor Colossus loop).":
    "CC BY 3.0、Matthew Pablo（matthewpablo.com）。ボス戦の音楽（Blackmoor Colossus のループ版）。",
  "CC0. The victory sting (its opening fanfare).":
    "CC0。勝利のジングル（冒頭のファンファーレ）。",
  "CC BY 4.0. The defeat sting.":
    "CC BY 4.0。敗北のジングル。",
  "Camera awareness": "カメラ認識",
  "Apache-2.0, Google. The on-device face and hand models that notice presence and gestures on the shared camera — nothing leaves the device.":
    "Apache-2.0、Google。共有カメラ上で在席とジェスチャーに気づく端末内の顔・手モデル — 端末の外には何も出ません。",
  "MIT, Neko Ayaka and contributors. The bot's brain architecture and its pathfinder patches are ported from their Minecraft integration.":
    "MIT、Neko Ayaka および貢献者の皆さん。ボットのブレイン構成と pathfinder パッチは、その Minecraft 連携から移植しています。",
  "MIT, Kolby Nottingham. Where those pathfinder patches came from, plus the building designs the bot can construct.":
    "MIT、Kolby Nottingham。上記 pathfinder パッチの出自であり、ボットが建築できる設計図の提供元です。",
  "MIT. mineflayer and friends, the bot's connection to the game.":
    "MIT。mineflayer とその関連ライブラリ。ボットとゲームをつなぎます。",

  // ── Locale-aware call injections (model-facing, not shown in the UI) ────
  "[System]: The call reconnected after a window change on the user's side. Do not greet or announce yourself — simply continue the conversation from where it left off.":
    "[System]: ユーザー側のウィンドウ切り替え後に通話が再接続されました。挨拶や名乗りはせず、会話を中断したところからそのまま続けてください。",
  "You are joining a live voice call already in progress. You have not heard what was said before you joined.":
    "あなたは進行中の音声通話に途中から参加します。参加前に話された内容は聞いていません。",
  "[System]: You have just joined the call. Briefly greet the participants in character.":
    "[System]: いま通話に参加しました。キャラクターを保ったまま、参加者に短く挨拶してください。",
  // Idle events (companion editor) + Live chat (Settings)
  "Idle events": "アイドルイベント",
  "When a voice call goes quiet, the companion gets one of these prompts, drawn at random by weight: a check-in after a silence, a topic to riff on, or a message from your stream's chat to answer (chat channels are set up in Settings → Live chat). Takes effect from the next call.":
    "音声通話が静かになると、コンパニオンにこれらのプロンプトのどれかが重みに応じてランダムに届きます。沈黙のあとの声かけ、話を広げる話題、配信チャットのメッセージへの返答など（チャットのチャンネルは 設定 → ライブチャット で設定します）。次の通話から反映されます。",
  "Enable idle events on voice calls": "音声通話でアイドルイベントを有効にする",
  "How long the call has to stay quiet before an event fires, counted from the end of the companion's last line and started over whenever you speak or type. With two different numbers each quiet stretch picks a random length between them, so events don't land like clockwork.":
    "イベントが発生するまでに通話が静かでなければならない時間です。コンパニオンの最後のセリフが終わった時点から数え、あなたが話したり入力したりするたびに数え直します。2つの値を変えると、静かな時間ごとにその間のランダムな長さが選ばれるので、イベントが機械的な間隔になりません。",
  "Quiet time before an event (seconds)": "イベントまでの静かな時間（秒）",
  "to": "〜",
  "After this many events in a row with no reply from you - and no new stream chat - the events pause until someone speaks, types or chats. Keeps a forgotten call from talking to an empty room, and lets the idle hang-up in Settings end it. 0 never pauses: for streams where the companion should keep going.":
    "あなたからの返事も新しい配信チャットもないままイベントがこの回数続くと、誰かが話す・入力する・チャットするまでイベントを一時停止します。放置された通話で誰もいない部屋に話し続けるのを防ぎ、設定のアイドル時自動切断で通話が終わるようにします。0 にすると一時停止しません（コンパニオンに話し続けてほしい配信向け）。",
  "Pause after this many unanswered events": "返事のないイベントがこの回数続いたら一時停止",
  "Events": "イベント",
  "No events yet.": "イベントはまだありません。",
  "(no prompt)": "（プロンプトなし）",
  "latest %s": "最新 %s 件",
  "after %s s": "%s 秒後",
  "Quiet-moment and stream-chat prompts for calls — imported switched off, ready to review and turn on":
    "通話中の静かな時間や配信チャット向けのプロンプト — オフの状態でインポートされるので、確認してからオンにできます",
  "Save event": "イベントを保存",
  "Silent stream chat injection (standalone)": "配信チャットをそっと挿入（単独）",
  "Inject after (seconds of quiet)": "挿入までの静かな時間（秒）",
  "How long after the last line ends before the unread chat slips in - once per quiet stretch. 0 = as soon as the line has finished playing. The companion sees it before its next reply, whether that reply is to you or to an idle event.":
    "最後のセリフが終わってから未読チャットを差し込むまでの時間です（静かな時間ごとに1回）。0 ならセリフの再生が終わった直後。コンパニオンは次の返答の前にそれを目にします — あなたへの返答でも、アイドルイベントへの返答でも。",
  "Optional - e.g. 'Bring it up if something stands out.'": "任意 — 例：「気になるものがあれば話題にして。」",
  "The open idle event has no prompt — finish it or cancel it, then save again.":
    "開いているアイドルイベントにプロンプトがありません。入力するかキャンセルしてから、もう一度保存してください。",
  "e.g. Fish facts": "例：魚の豆知識",
  "How often this event is picked compared with the others; the percentage is its share while every event can run. Chat events only take part while there is unread chat. 0 never picks it.":
    "他のイベントと比べてどれくらい選ばれやすいかです。パーセントは、すべてのイベントが実行できるときの割合です。チャットのイベントは未読のチャットがあるときだけ対象になります。0 にすると選ばれません。",
  "Weight": "重み",
  "What the event does. Prompt only: its prompt, drawn by weight once the call goes quiet. Read stream chat: the same, plus the newest unread messages from your stream's chat - Twitch and YouTube together, each with the viewer's name - so the companion can pick what to answer; it waits while there's no unread chat. Silent stream chat injection (standalone): not drawn - after its own quiet time the newest unread chat slips in as background the companion sees before its next reply, without asking for one. Channels are set up in Settings → Live chat.":
    "イベントの動作です。プロンプトのみ：通話が静かになると、重みに応じて選ばれたプロンプトが届きます。配信チャットを読む：同じく、配信チャットの最新の未読メッセージ（Twitch と YouTube をまとめて、それぞれ視聴者の名前付き）を添え、どれに返答するかはコンパニオンが選べます。未読のチャットがない間は待機します。配信チャットをそっと挿入（単独）：抽選には加わらず、専用の静かな時間のあとに最新の未読チャットを背景情報として差し込みます。コンパニオンは次の返答の前にそれを目にしますが、返答を促しはしません。チャンネルは 設定 → ライブチャット で設定します。",
  "Type": "種類",
  "Prompt only": "プロンプトのみ",
  "Read stream chat": "配信チャットを読む",
  "How many of the newest unread chat messages to add. Each read catches up: older unread chat is skipped, the way a streamer glances at chat, and no message is read twice.":
    "添える最新の未読チャットメッセージの数です。読むたびに追いつくので、それより古い未読チャットは配信者がチャットをちらっと見るときのように飛ばされ、同じメッセージが二度読まれることはありません。",
  "Latest messages to read": "読む最新メッセージ数",
  "e.g. 'Look up a random fact about fish online and share your thoughts on it, in a humorous tone.'":
    "例：「ネットで魚についてのランダムな豆知識を調べて、ユーモアたっぷりに感想を話して。」",
  "Add event": "イベントを追加",
  "This companion has chat idle events, but no live chat is set up — add a Twitch channel or a YouTube stream in Settings → Live chat.":
    "このコンパニオンにはチャットのアイドルイベントがありますが、ライブチャットが設定されていません。設定 → ライブチャット で Twitch チャンネルか YouTube 配信を追加してください。",
  "%s chat: %s": "%s チャット：%s",
  "Live chat": "ライブチャット",
  "Let companions read your stream's chat through idle events: set a companion's idle event to 'Read stream chat' on the Companions tab. Chat only connects during a call whose companion has such an event, and disconnects a minute after the call ends.":
    "アイドルイベントを通じて、コンパニオンが配信のチャットを読めるようにします。コンパニオンタブで、コンパニオンのアイドルイベントの種類を「配信チャットを読む」にしてください。チャットはそのようなイベントを持つコンパニオンとの通話中だけ接続し、通話が終わって1分後に切断します。",
  "Read anonymously - no Twitch account or token needed. Messages a moderator deletes, and everything from a user they time out or ban, are dropped before a companion reads them.":
    "匿名で読み取るので、Twitch アカウントやトークンは不要です。モデレーターが削除したメッセージや、タイムアウト・BAN されたユーザーのメッセージは、コンパニオンが読む前に取り除かれます。",
  "Twitch channel": "Twitch チャンネル",
  "channel name or twitch.tv link": "チャンネル名または twitch.tv のリンク",
  "The link (or video id) of the stream that's live right now - each new stream has a new link. Chat is checked every 20 seconds to stay inside YouTube's free daily API quota.":
    "現在ライブ中の配信のリンク（または動画 ID）です。配信ごとにリンクが変わります。YouTube の無料の1日あたり API 割り当て内に収まるよう、チャットは20秒ごとに確認します。",
  "YouTube live stream": "YouTube ライブ配信",
  "A YouTube Data API v3 key from the Google Cloud console (APIs & Services → Credentials). Stored on this machine only.":
    "Google Cloud コンソール（API とサービス → 認証情報）で作成した YouTube Data API v3 のキーです。このマシンにだけ保存されます。",
  "YouTube API key": "YouTube API キー",
  "remove": "削除",
  "Messages from these names never reach a companion - chat bots, or anyone you'd rather not hear from. Comma-separated, not case-sensitive.":
    "これらの名前からのメッセージはコンパニオンに届きません。チャットボットや、聞きたくない相手などに。カンマ区切りで、大文字と小文字は区別しません。",
  "Ignored users (comma-separated)": "無視するユーザー（カンマ区切り）",
  "A message containing any of these is dropped before a companion reads it - matched anywhere, inside words too. Comma-separated, not case-sensitive. Commands starting with ! are always skipped.":
    "これらのいずれかを含むメッセージは、コンパニオンが読む前に取り除かれます。単語の途中でも一致します。カンマ区切りで、大文字と小文字は区別しません。! で始まるコマンドは常にスキップされます。",
  "Blocked words (comma-separated)": "ブロックする語句（カンマ区切り）",

  // ── Gesture generation (Text-To-VRMA) ─────────────────────────────────
  "Gesture generation (Text-To-VRMA)": "ジェスチャー生成（Text-To-VRMA）",
  "Gesture generation": "ジェスチャー生成",
  "Lets companions invent brand-new avatar motions from a description during voice calls (generate_gesture), made by the free, open-source Text-To-VRMA app running on your computer.":
    "音声通話中に、コンパニオンが説明文からまったく新しいアバターのモーションを作れるようにします（generate_gesture）。モーションは、お使いのパソコンで動く無料のオープンソースアプリ Text-To-VRMA が生成します。",
  "Download Text-To-VRMA": "Text-To-VRMA をダウンロード",
  "In that app open Advanced settings → Local HTTP API and switch it on, then copy the address and the access token it shows into the fields below. Its local ARDY engine is free and needs no key (press \"Start engine\" in the app first); the OpenAI, Claude and Codex engines use the keys or login saved in that app.":
    "アプリ側で「詳細設定 → ローカルHTTP API」を開いて有効にし、表示されるアドレスとアクセストークンを下の欄にコピーしてください。ARDY ローカルエンジンは無料でキーも不要です（先にアプリで「エンジンを起動」を押してください）。OpenAI、Claude、Codex の各エンジンは、アプリに保存したキーまたはログインを使います。",
  "Enable gesture generation": "ジェスチャー生成を有効にする",
  "The master switch. Each companion also needs \"Gesture generation\" switched on in the Companions tab, and the tool is only offered while the app is answering.":
    "全体のスイッチです。さらに「コンパニオン」タブで各コンパニオンの「ジェスチャー生成」をオンにする必要があります。ツールはアプリが応答している間だけ提供されます。",
  "Text-To-VRMA API URL": "Text-To-VRMA API の URL",
  "The access token Text-To-VRMA shows once its Local HTTP API is enabled. Fixed per install; if you regenerate it in the app, paste the new one here.":
    "ローカルHTTP API を有効にすると Text-To-VRMA に表示されるアクセストークンです。インストールごとに固定です。アプリで再生成した場合は、新しいトークンをここに貼り付けてください。",
  "Access token": "アクセストークン",
  "•••••••• (leave blank to keep current token)": "••••••••（空欄のままなら現在のトークンを維持）",
  "engines": "エンジン",
  "key": "キー",
  "set": "設定済み",
  "What makes the motion, same choice as in the app. ARDY is NVIDIA's motion model running locally: free, a few seconds per motion on a GPU, best at full-body movement. The others have a language model write the keyframes: slower, billed by that provider (Codex uses your ChatGPT subscription).":
    "モーションを作るエンジンです。アプリ内の選択肢と同じです。ARDY はローカルで動く NVIDIA のモーション生成モデルで、無料、GPU なら1回数秒、全身の動きが得意です。その他は言語モデルがキーフレームを書く方式で、時間がかかり、各プロバイダーの料金がかかります（Codex は ChatGPT のサブスクリプション枠を使います）。",
  "Engine": "エンジン",
  "ARDY local engine (free)": "ARDY ローカルエンジン（無料）",
  "Codex (ChatGPT subscription)": "Codex（ChatGPT サブスクリプション）",
  "Optionally let a language model read the description first and split it into steps for ARDY (\"run, then jump\"). None sends the description straight to ARDY: fastest, no key needed.":
    "必要に応じて、言語モデルに先に説明文を読ませ、ARDY 向けの手順に分割させます（「走ってからジャンプ」など）。「なし」は説明文をそのまま ARDY に送ります。最速で、キーも不要です。",
  "ARDY planner": "ARDY のプランナー",
  "None (fastest)": "なし（最速）",
  "Fast keeps the model's thinking and keyframe count down and skips the second review pass, the right choice mid-conversation. Quality thinks longer.":
    "「速度優先」はモデルの推論量とキーフレーム数を抑え、2回目の見直しを省きます。会話中はこれが向いています。「品質優先」はより長く考えます。",
  "Speed": "速度",
  "Fast": "速度優先",
  "Balanced": "バランス",
  "Quality": "品質優先",
  "Model id for the chosen engine or planner, as you would pick it in the app. Empty = the app's default.":
    "選んだエンジンまたはプランナーで使うモデル ID です。アプリで選ぶものと同じです。空欄ならアプリの既定値を使います。",
  "Model (optional)": "モデル（任意）",
  "Rexclaw in Docker or WSL while Text-To-VRMA runs on Windows? The app only listens on 127.0.0.1, so it has to be on the same machine as the Rexclaw server (the desktop app and run.bat are). Generated motions land in data/assets/generated/text_to_vrma/ and show up in every avatar's Library picker.":
    "Rexclaw を Docker や WSL で動かし、Text-To-VRMA は Windows 側で動かしていますか？ アプリは 127.0.0.1 でしか待ち受けないため、Rexclaw サーバーと同じマシン上にある必要があります（デスクトップアプリと run.bat なら同じマシンです）。生成したモーションは data/assets/generated/text_to_vrma/ に保存され、すべてのアバターの「ライブラリ」に表示されます。",
  "Lets the companion invent brand-new avatar motions from a description during voice calls (generate_gesture), for anything its gesture list doesn't cover. Made by the free Text-To-VRMA app running on your computer: connect it and switch it on in Settings → Gesture generation. The tool is only offered while that app's local API is answering. Motions are saved to data/assets/generated/text_to_vrma/ and can be added to an avatar's custom gestures from the Library picker.":
    "音声通話中に、コンパニオンが説明文からまったく新しいアバターのモーションを作れるようにします（generate_gesture）。ジェスチャー一覧にない動きに使います。モーションは、お使いのパソコンで動く無料アプリ Text-To-VRMA が生成します。「設定 → ジェスチャー生成」で接続して有効にしてください。ツールは、そのアプリのローカル API が応答している間だけ提供されます。モーションは data/assets/generated/text_to_vrma/ に保存され、「ライブラリ」からアバターのカスタムジェスチャーに追加できます。",
  "MIT, Kiratchi. The separate app that makes the generate_gesture motions over its local HTTP API. Not bundled: you install and run it yourself.":
    "MIT、Kiratchi。ローカル HTTP API 経由で generate_gesture のモーションを生成する別アプリです。同梱はしていません。ご自身でインストールして起動します。",

  // ── Companion tool tooltips ──
  "Third Party Integration Tools": "サードパーティ連携ツール",
  "Tools that need a separate app running on your computer. Each is only offered to the companion while that app is connected.":
    "お使いのパソコンで別のアプリを起動しておく必要があるツールです。それぞれ、そのアプリが接続されている間だけコンパニオンに提供されます。",
  "When ANOTHER companion texts this one (affects text_companion), let this one use its own tools (memory, pictures, delegated tasks, Minecraft, MCP servers) while writing the reply — so a companion can ask this one to do something it isn't equipped for itself. Two things to know: the sender waits for the whole reply, so a slow tool here is silence in their live call, and anything generated lands in this companion's own chat and the library rather than coming back to the sender. Turn it off for a companion whose tools are slow or expensive.":
    "「別の」コンパニオンがこのコンパニオンにテキストを送ってきたとき（text_companion に影響）、返信を書く間にこのコンパニオン自身のツール（メモリ、画像、委任タスク、Minecraft、MCP サーバー）を使えるようにします。これにより、あるコンパニオンが自分ではできないことをこのコンパニオンに頼めます。注意点が 2 つあります。送信側は返信全体を待つため、ここでツールが遅いと相手のライブ通話が無音になります。また、生成されたものは送信側には戻らず、このコンパニオン自身のチャットとライブラリに保存されます。ツールが遅い、または高コストなコンパニオンではオフにしてください。",
  "Let this companion use tools when texted": "テキストを受け取ったときにツールを使えるようにする",
  "Locomotion tools": "移動ツール",
  "Lets the companion walk about on its own during voice calls (move_around): come right up close to you, step back to its usual spot, wander or pace a little, follow your view as you move the camera, and turn to face you. Recommended only with a 3D scene background, where there is a room to move through. Not offered in group calls.":
    "音声通話中に、コンパニオンが自分で歩き回れるようにします（move_around）。すぐそばまで近づく、いつもの位置に戻る、少し歩き回る、行ったり来たりする、カメラを動かすとついてくる、あなたの方を向く、といった動きができます。歩ける部屋がある 3D シーンの背景でのみおすすめします。グループ通話では提供されません。",

  // ── Gesture zoom-out ──
  "Zoom out for manual gestures in face view": "顔ビューで手動ジェスチャー中にズームアウトする",
  "The camera pulls out while a gesture plays, so it is not out of shot, then eases back in. Only for gestures someone chose (the companion's own, or the trigger buttons), not the automated ones above.":
    "ジェスチャーの再生中はカメラが引いて画面の外に出ないようにし、終わるとゆっくり元に戻ります。対象は誰かが選んだジェスチャー（コンパニオン自身によるもの、またはトリガーボタン）だけで、上の自動ジェスチャーは含みません。",
  "Pulls the camera out while a chosen gesture plays (the companion's own, or a manual trigger), so the body is in shot, and eases back in afterwards. The automated ones above never move the camera.":
    "選ばれたジェスチャー（コンパニオン自身によるもの、または手動トリガー）の再生中にカメラを引いて体が映るようにし、終わるとゆっくり元に戻します。上の自動ジェスチャーではカメラは動きません。",

  // ── Library animation picker ──
  "Library animations": "ライブラリのアニメーション",
  "Play any animation from the shared asset library once, even if it is not one of this avatar's gestures":
    "共有アセットライブラリ内の任意のアニメーションを1回再生します。このアバターのジェスチャーに含まれていないものも再生できます",

  // ── Gaps found by a full _t() audit (2026-09-18) ──
  "Unsaved changes": "未保存の変更",
  "You have unsaved changes on this tab. Save them before leaving?":
    "このタブには未保存の変更があります。移動する前に保存しますか？",
  "loops": "ループ",
  "from ±": "最小 ±",
  "Speaks first on voice calls": "音声通話で先に話し始める",
  "When you resume a conversation, a dated note tells the companion when the two of you last spoke and how long ago that was, so it can pick up naturally after hours or days instead of mid-sentence - and a companion who speaks first opens with the time of day in mind. The note is visible in the transcript.":
    "会話を再開すると、前回いつ話したか、それからどれくらい経ったかを日付つきのメモでコンパニオンに伝えます。数時間後や数日後でも、話の途中からではなく自然に再開できます。先に話し始める設定のコンパニオンは、時間帯を踏まえて話し始めます。メモはトランスクリプトに表示されます。",
  "•••••••• (leave blank to keep current header)": "••••••••（空欄のままなら現在のヘッダーを維持）",

  // ── Stage (karaoke) ─────────────────────────────────────────────────
  "Stage: your companion sings and dances to a song, karaoke style": "ステージ：コンパニオンがカラオケのように歌って踊ります",
  "Hide the stage": "ステージを閉じる",
  "Songs (perform_song)": "歌（perform_song）",
  "Lets the companion perform a song on the karaoke stage during a voice call (perform_song): the backing plays, they sing and dance, and the lyrics roll on screen. It offers only the songs they have already learned in their current singing voice (Teach on the Stage panel), so nothing is rendered during the call. The call stays connected while the song plays.":
    "音声通話中に、コンパニオンがカラオケステージで曲を披露できるようにします（perform_song）。伴奏が流れ、歌って踊り、歌詞が画面に流れます。今の歌声ですでに覚えた曲（ステージパネルの「教える」）だけを選べるので、通話中に音声を生成することはありません。曲の間も通話はつながったままです。",
  "They": "コンパニオン",
  "Import failed.": "インポートに失敗しました。",
  "Upload failed.": "アップロードに失敗しました。",
  "Delete the song '%s'? Every voice that learned it forgets it too; recordings are kept.":
    "曲「%s」を削除しますか？ 覚えた声もすべて忘れます。録音は残ります。",
  "Stage": "ステージ",
  "Built-in": "内蔵",
  "%s knows this one": "%s はこの曲を歌えます",
  "Written by a companion": "コンパニオン作",
  "duet": "デュエット",
  "%s sings": "%s が歌う",
  "They sing and dance; turn on scoring below to sing along.": "コンパニオンが歌って踊ります。一緒に歌うなら下の採点をオンに。",
  "Duet": "デュエット",
  "They sing part one, you sing part two.": "コンパニオンがパート1、あなたがパート2を歌います。",
  "You take turns: every other line is yours.": "交互に歌います。1行おきにあなたの番です。",
  "You sing": "あなたが歌う",
  "Karaoke for you: the backing plays, they dance, your singing is scored.": "あなたのカラオケ：伴奏が流れ、コンパニオンが踊り、あなたの歌が採点されます。",
  "Each lyric line is spoken in their voice (xAI text-to-speech, billed per character) and re-sung onto the melody. Takes a minute or two; done once per voice.":
    "歌詞を1行ずつコンパニオンの声で読み上げ（xAI の音声合成、文字数課金）、メロディに乗せて歌い直します。1〜2分かかります。声ごとに1回だけです。",
  "Teach %s this song": "%s にこの曲を教える",
  "Singing line %s of %s": "%s / %s 行目を歌っています",
  "Speaking the lyrics: %s of %s lines": "歌詞を読み上げ中：%s / %s 行",
  "Perform": "披露する",
  "Stop": "停止",
  "Dance to the beat: the built-in dances and yours, warped onto the music's beats; quiet passages get a gentle groove instead.":
    "ビートに合わせて踊ります。内蔵のダンスとあなたのダンスを曲の拍に合わせ、静かなところでは軽くリズムに乗ります。",
  "Cut between close-ups, waist shots and wide shots on the bar lines, like a music show.":
    "音楽番組のように、小節の頭でアップ・バストショット・引きのショットを切り替えます。",
  "Stage camera": "ステージカメラ",
  "Songs": "曲",
  "Choose": "選ぶ",
  "Add songs": "曲を追加",
  "%s knows": "%sが歌える",
  "By companions": "コンパニオン作",
  "Imported": "インポート",
  "Search by title or artist": "曲名やアーティストで検索",
  "Sort": "並べ替え",
  "A to Z": "名前順",
  "Newest first": "新しい順",
  "No songs match.": "該当する曲がありません。",
  "No songs yet: add one on the Add songs tab.": "まだ曲がありません。「曲を追加」タブから追加してください。",
  "No dances of your own yet; the built-in ones always join in.": "自分のダンスはまだありません。内蔵のダンスはいつでも使われます。",
  "No song chosen yet.": "まだ曲が選ばれていません。",
  "Choose song…": "曲を選ぶ…",
  "Stop the song": "曲を止める",
  "Your companion sings and dances on the desktop, with the lyrics under them.": "コンパニオンがデスクトップで歌って踊り、その下に歌詞が表示されます。",
  "They sing and dance on your desktop.": "デスクトップで歌って踊ります。",
  "Options": "オプション",
  "Note bars": "音程バー",
  "Show the melody as bars scrolling above the avatar, with your pitch when your singing is scored.": "アバターの上にメロディーをバーで流して表示します。歌を採点しているときは、あなたの音程も表示します。",
  "Listen to your singing through the mic and score it like UltraStar: in tune within the difficulty's range, any octave. Headphones help: the speakers leak into the mic.":
    "マイクであなたの歌を聴き、UltraStar のように採点します。難易度の範囲内で音程が合っていれば、オクターブは問いません。スピーカーの音がマイクに入るので、ヘッドホンがおすすめです。",
  "Score my singing": "自分の歌を採点",
  "How close to the note counts: easy ±2 semitones, medium ±1, hard exact":
    "どこまで音程が合えば正解か：かんたん ±2 半音、ふつう ±1、むずかしい ぴったり",
  "Easy": "かんたん",
  "Hard": "むずかしい",
  "Their voice": "歌声の音量",
  "Re-arrange the backing in another style (the singing stays)": "伴奏を別のスタイルでアレンジし直します（歌声はそのまま）",
  "Style…": "スタイル…",
  "Mix their singing with the backing into one recording, listed under History → Recordings":
    "歌声と伴奏を1つの録音にまとめ、履歴 → 録音 に追加します",
  "Save recording": "録音を保存",
  "Sing it again in their voice (the result differs a little every time)": "もう一度その声で歌い直します（毎回少しずつ変わります）",
  "Delete song": "曲を削除",
  "UltraStar songs: pick the .txt together with its audio (and its instrumental, if the song has one). Charts for thousands of songs are shared by the UltraStar community; the audio is your own.":
    "UltraStar の曲：.txt と音声ファイル（インストがあればそれも）を一緒に選びます。何千曲もの譜面が UltraStar コミュニティで共有されています。音声はご自身のものを使ってください。",
  "What to do with the original singer on a full mix": "原曲の歌声が入った音源の扱い",
  "Use the instrumental if included": "インストがあればそれを使う",
  "Reduce the original vocals (centre cut)": "原曲のボーカルを抑える（センターカット）",
  "Keep the audio as it is": "音声をそのまま使う",
  "Import UltraStar song…": "UltraStar の曲をインポート…",
  "Dances": "ダンス",
  "MMD motions (.vmd) and VRM animations (.vrma). Link an MMD dance to the song it was made for and it plays in sync, start to finish; unlinked dances join the mix for every song.":
    "MMD モーション（.vmd）と VRM アニメーション（.vrma）。MMD のダンスを作られた曲に紐付けると、最初から最後まで同期して踊ります。紐付けないダンスはすべての曲で組み合わせて使われます。",
  "The song this dance was made for": "このダンスが作られた曲",
  "Any song": "すべての曲",
  "Delete dance": "ダンスを削除",
  "Where the dance's first frame falls on the song, in milliseconds (MMD dances often start a few seconds in)":
    "ダンスの最初のフレームが曲のどこに来るか（ミリ秒）。MMD のダンスは数秒後から始まることがよくあります",
  "Offset ms": "オフセット（ms）",
  "How far below horizontal the MMD model's arms rest (the standard Miku model: 30°). Raise it if the arms float, lower it if they cross the body.":
    "MMD モデルの基本姿勢で腕が水平から何度下がっているか（標準のミクモデル：30°）。腕が浮くなら大きく、体にめり込むなら小さくします。",
  "Arm angle": "腕の角度",
  "Add dance…": "ダンスを追加…",
  "UltraStar-style score: 9000 for notes sung in tune, 1000 for whole lines": "UltraStar 式の採点：音程の合った音符で 9000 点、行ごとのボーナスで 1000 点",
  "Singing failed.": "歌えませんでした。",
  "They haven't learned this song yet.": "まだこの曲を覚えていません。",
  "Microphone unavailable, so your singing is not scored.": "マイクが使えないため、歌は採点されません。",
  "Karaoke stage": "カラオケステージ",
  "Synced lyrics for songs imported from a link or a video.": "リンクや動画から取り込んだ曲の同期歌詞。",
  "Voice Lab (optional download)": "ボイスラボ（オプションのダウンロード）",
  "MIT. Trains the singing voice profiles, re-sings vocals in them and separates songs into music and vocals (audio-separator models).":
    "MIT。歌声プロファイルを学習し、その声でボーカルを歌い直し、曲を音楽とボーカルに分離します（audio-separator のモデル）。",
  "MIT. Times the lyrics of imported songs and scores voice checkpoints.": "MIT。取り込んだ曲の歌詞のタイミングを取り、声のチェックポイントを採点します。",
  "Unlicense. Fetches songs from links.": "Unlicense。リンクから曲を取得します。",
  "MIT / Apache-2.0. Sets up the Voice Lab's own Python environment.": "MIT / Apache-2.0。ボイスラボ専用の Python 環境を用意します。",
  // ── Voice Lab ────────────────────────────────────────────────────────
  "Voice Lab (singing voices)": "ボイスラボ（歌声）",
  "An optional engine for the karaoke stage. It trains a singing voice from recordings you upload, so a companion sings in that voice, and it turns songs from links or videos into karaoke: the music, the original singer's vocal (which the voice re-sings) and the lyrics. It runs on your own computer; an NVIDIA graphics card makes it fast.":
    "カラオケステージ用のオプションのエンジンです。アップロードした録音から歌声を学習し、コンパニオンがその声で歌えるようにします。また、リンクや動画の曲を、伴奏・元の歌手のボーカル（学習した声で歌い直します）・歌詞に分けてカラオケにします。お使いのコンピューター上で動き、NVIDIA のグラフィックカードがあると高速です。",
  "Install the Voice Lab": "ボイスラボをインストール",
  "The Voice Lab is not available on macOS: its voice engine has no Mac version. The built-in singing still works.":
    "ボイスラボは macOS では利用できません（音声エンジンに Mac 版がないため）。内蔵の歌声はそのまま使えます。",
  "About %s GB download and disk space, kept in the app's data folder.": "約 %s GB のダウンロードとディスク容量が必要です（アプリのデータフォルダーに保存）。",
  "NVIDIA graphics card found: it installs the fast (CUDA) version.": "NVIDIA のグラフィックカードが見つかりました。高速な CUDA 版をインストールします。",
  "No NVIDIA graphics card found: it installs the CPU version, which works but trains voices very slowly.": "NVIDIA のグラフィックカードが見つかりません。CPU 版をインストールします。動作はしますが、声の学習はとても遅くなります。",
  "Running on %s": "%s で実行中",
  "Installed; starts by itself when needed": "インストール済み。必要なときに自動で起動します",
  "Delete the engine and its models from the data folder. Voice profiles need it to sing.": "エンジンとモデルをデータフォルダーから削除します。歌声プロファイルで歌うにはエンジンが必要です。",
  "Remove the Voice Lab? Its engine, models and trained voices are deleted; companions go back to the built-in singing.":
    "ボイスラボを削除しますか？ エンジン、モデル、学習した声が削除され、コンパニオンは内蔵の歌唱に戻ります。",
  "Singing voice profiles": "歌声プロファイル",
  "Upload clean recordings of one voice (speech or singing, no music or other voices), ideally 10 to 30 minutes in total; singing in the mix helps the high notes. Only use a voice you have the right to use. Training runs in the background: about 18 seconds per round (epoch) for 5 minutes of audio on an RTX 3070, so a 20-minute voice at 200 rounds takes about 4 hours. The best checkpoint is picked by how clearly it still says the words.":
    "1人の声のクリーンな録音（話し声または歌声。音楽や他の声は入れない）をアップロードします。合計10〜30分が理想で、歌声が含まれると高音がよくなります。使う権利のある声だけを使ってください。学習はバックグラウンドで行われ、RTX 3070 で5分の音声なら1ラウンド（エポック）約18秒、20分の声を200ラウンドなら約4時間かかります。最良のチェックポイントは、言葉をどれだけはっきり発音できるかで自動的に選ばれます。",
  "Ready · %s min of audio · epoch %s": "準備完了 · 音声 %s 分 · エポック %s",
  "Training": "学習中",
  "Stopped at %s when the app closed · ↻ carries on": "アプリ終了により %s で停止 · ↻ で続きから",
  "Carry on training from the last checkpoint": "最後のチェックポイントから学習を続ける",
  "Train again from the start, on the recordings it has": "今ある録音で最初から学習し直す",
  "Add more recordings and train again": "録音を追加してもう一度学習",
  "Delete this voice": "この声を削除",
  "Delete the voice '%s'? Songs it sang are forgotten too.": "声「%s」を削除しますか？ その声で歌った曲も忘れます。",
  "Word errors by checkpoint:": "チェックポイントごとの単語誤り率:",
  "New voice name": "新しい声の名前",
  "e.g. Eve": "例: Eve",
  "More rounds learn the voice more closely and take longer. The RVC project suggests 200 for clean recordings, and 20 to 30 for noisy ones.": "ラウンドを増やすほど声をより忠実に学習しますが、時間がかかります。RVC プロジェクトの目安は、クリーンな録音なら200、ノイズの多い録音なら20〜30です。",
  "Epochs": "エポック",
  "Choose recordings and train": "録音を選んで学習",
  "Starting": "開始中",
  "A voice profile from the Voice Lab (Settings) makes them sing in that voice; the built-in engine re-sings their speaking voice.":
    "ボイスラボ（設定）の歌声プロファイルを選ぶとその声で歌います。内蔵エンジンは話し声を歌声に変えます。",
  "Singing voice": "歌声",
  "from a link or video": "リンク・動画から",
  "Songs from a link or video are sung through a voice profile: pick one under Singing voice (train one in Settings → Voice Lab). You can still sing it yourself.":
    "リンクや動画の曲は歌声プロファイルで歌います。「歌声」で選んでください（設定 → ボイスラボで学習できます）。自分で歌うこともできます。",
  "Their voice profile re-sings the original singer's vocal. Takes about a minute.": "歌声プロファイルが元の歌手のボーカルを歌い直します。約1分かかります。",
  "Each lyric line is spoken in their voice (xAI text-to-speech, billed per character), sung onto the melody and re-sung by their voice profile. Takes a minute or two.":
    "歌詞を1行ずつその声で読み上げ（xAI の音声合成、文字数課金）、メロディに乗せ、歌声プロファイルで歌い直します。1〜2分かかります。",
  "Re-singing in the profile voice (%s%)": "プロファイルの声で歌い直し中（%s%）",
  "From a link or a video": "リンクまたは動画から",
  "Paste a link to a song (YouTube and most video or music sites) or pick a video or audio file. The Voice Lab separates the music from the singer, finds the lyrics (LRCLIB, or by listening) and charts the melody; a voice profile then sings it in place of the original singer. Only use songs you have the right to use: downloading from YouTube is against its Terms of Service unless the video allows it.":
    "曲のリンク（YouTube やほとんどの動画・音楽サイト）を貼り付けるか、動画・音声ファイルを選びます。ボイスラボが音楽と歌声を分け、歌詞を探し（LRCLIB、または聞き取り）、メロディを譜面にします。その後、歌声プロファイルが元の歌手の代わりに歌います。使う権利のある曲だけを使ってください。YouTube からのダウンロードは、動画が許可していない限り利用規約違反です。",
  "Video or audio file…": "動画・音声ファイル…",
  "Needs the Voice Lab: install it in Settings → Voice Lab.": "ボイスラボが必要です。設定 → ボイスラボでインストールしてください。",
  "UltraStar songs": "UltraStar の曲",
  "Modified BSD (WORLD), MIT (pyworld). Analyses a companion's spoken lyrics and re-sings them onto the melody.":
    "修正 BSD（WORLD）、MIT（pyworld）。コンパニオンが読み上げた歌詞を分析し、メロディに乗せて歌い直します。",
  "Extensions": "拡張機能",
  "Add-ons that live outside the app: each is a folder with a plugin.json. Put them in %s, or list other folders below. Extensions load when Rexclaw starts, so changes here apply after a restart. Only install extensions you trust: they run with the same access as the app.":
    "アプリ本体の外にあるアドオンです。それぞれ plugin.json を含むフォルダです。%s に置くか、下に別のフォルダを指定してください。拡張機能は Rexclaw の起動時に読み込まれるため、ここでの変更は再起動後に反映されます。拡張機能はアプリと同じ権限で動作するので、信頼できるものだけを入れてください。",
  "No extensions found.": "拡張機能は見つかりませんでした。",
  "Running": "実行中",
  "Loads after a restart": "再起動後に読み込まれます",
  "Turns off after a restart": "再起動後にオフになります",
  "Open": "開く",
  "Extra extension folders (one per line)": "追加の拡張機能フォルダ（1 行に 1 つ）",
  "e.g. C:\\Users\\me\\my-extensions": "例: C:\\Users\\me\\my-extensions",
  "Save folders": "フォルダを保存",
  "Restart Rexclaw to apply the changes.": "変更を反映するには Rexclaw を再起動してください。",
  "Download %s": "%s をダウンロード",

  // ── Manga Diary (History → Manga) ─────────────────────────────────────
  "Manga": "漫画",
  "Manga Diary": "漫画日記",
  "Turn an episode of a conversation into a manga page starring your companion. Episodes are the chapters your companions' memory already keeps: each compaction rolls a stretch of conversation into one. The storyboard is written from that stretch alone, then your companion poses for every panel and the photos are inked into screentone art and lettered.":
    "会話のエピソードをコンパニオン主演の漫画ページにします。エピソードはコンパニオンの記憶がすでに持っている章で、圧縮のたびに会話のひと区切りが 1 つのエピソードになります。その区切りだけからネームを作り、コンパニオンが各コマのポーズを取り、その写真をスクリーントーンの線画に仕上げて写植します。",
  "Search episodes…": "エピソードを検索…",
  "Since the last episode": "前回のエピソード以降",
  "Latest conversation": "最新の会話",
  "%s messages": "%s 件のメッセージ",
  "Episode": "エピソード",
  "1 page drawn": "1 ページ描画済み",
  "%s pages drawn": "%s ページ描画済み",
  "%s pages": "%s ページ",
  "Page": "ページ",
  "Page %s of %s": "%s / %s ページ",
  "Page %s of %s · panel %s of %s": "%s / %s ページ · %s / %s コマ",
  "Page subtitle (optional)": "ページのサブタイトル（任意）",
  "Remove this page": "このページを削除",
  "Continuing \"%s\" after page %s: the storyboard picks up where it left off.":
    "「%s」の %s ページ目の続き：ネームは前回の続きから始まります。",
  "Start a new chapter instead": "代わりに新しい章を始める",
  "Continue the chapter": "章の続きを描く",
  "Cast (optional): other companions who took part, up to %s": "キャスト（任意）：登場した他のコンパニオン（最大 %s 人）",
  "What they wear now": "今の衣装",
  "Newest conversation first": "会話の新しい順",
  "One episode": "1 エピソード",
  "Combine episodes": "エピソードをまとめる",
  "Your own script": "自分の脚本",
  "%s episodes ticked, read together oldest first": "%s 件のエピソードを選択（古い順にまとめて読みます）",
  "Tick the episodes to read together.": "まとめて読むエピソードにチェックを入れてください。",
  "Write or paste the story you want drawn: who says what, what happens, where. Name the speakers, e.g.\nEve: You made pancakes? From scratch?\nYou: Every single one.":
    "漫画にしたい話を書くか貼り付けてください（誰が何を言い、何が起き、どこで）。話し手の名前を書いてください。例：\nイヴ：パンケーキ作ったの？一から？\nあなた：全部ね。",
  "Your outfit": "あなたの衣装",
  "Usual": "いつもの",
  "%s's outfit": "%s の衣装",
  "Cast outfit": "キャストの衣装",
  "Inking page %s…": "%s ページ目をペン入れ中…",
  "The %s page(s) finished before this were saved.": "それまでに仕上がった %s ページは保存されています。",
  "See the saved pages": "保存したページを見る",
  "Up to %s pages: the storyboard stops sooner if the episode runs out of moments. The photoshoot takes about %s minutes; each page is saved as soon as it's done.":
    "最大 %s ページ：エピソードの場面が尽きればネームはそこで終わります。撮影は約 %s 分で、各ページは仕上がり次第保存されます。",
  "Recently drawn first": "描いた新しい順",
  "Show %s in this panel": "このコマに %s を描く",
  "%s's face": "%s の表情",
  "Setting up the group shot…": "集合ショットを準備中…",
  "Pose this page's storyboard again, in today's scene (painted art is reused)":
    "このページのネームを今のシーンで撮り直す（描いた絵は再利用）",
  "Storyboard more pages of this episode, picking up after the last one":
    "このエピソードの続きのページを、最後のページの後からネームにする",
  "Nothing matches.": "一致するものがありません。",
  "Pick an episode above, or write the page yourself.": "上からエピソードを選ぶか、ページを自分で書いてください。",
  "Write it yourself": "自分で書く",
  "Start from a blank storyboard and write every panel yourself: no episode, no model call":
    "白紙のネームから始めて、すべてのコマを自分で書きます（エピソードもモデル呼び出しも不要）",
  "Chapter title": "章タイトル",
  "Untitled": "無題",
  "Panel %s": "%s コマ目",
  "Remove this panel": "このコマを削除",
  "Add a panel": "コマを追加",
  "Shot": "ショット",
  "Angle": "アングル",
  "Face": "表情",
  "Pose": "ポーズ",
  "Symbol": "漫符",
  "Effect": "効果",
  "Size": "大きさ",
  "Your face": "あなたの表情",
  "Caption (optional)": "ナレーション（任意）",
  "What they say": "セリフ",
  "Remove this balloon": "このフキダシを削除",
  "Balloon": "フキダシ",
  "Sound effect (optional)": "描き文字（任意）",
  "speech": "通常",
  "shout": "叫び",
  "thought": "心の声",
  "whisper": "ささやき",
  "Art": "作画",
  "Live photoshoot": "ライブ撮影",
  "Photoshoot in Imagine-painted scenes": "Imagine で描いた背景で撮影",
  "Imagine-illustrated panels": "Imagine で描くコマ",
  "Your companion poses in their current scene. No extra cost.": "コンパニオンが今のシーンでポーズを取ります。追加料金はかかりません。",
  "Grok Imagine paints each panel's setting and your companion poses in it: one image per panel, billed to your xAI account.":
    "Grok Imagine が各コマの背景を描き、コンパニオンがその中でポーズを取ります。1 コマにつき画像 1 枚で、xAI アカウントに請求されます。",
  "Grok Imagine draws every panel from the outfit's portrait: one image per panel, billed to your xAI account. A panel it can't draw is photographed instead.":
    "Grok Imagine が衣装のポートレートから各コマを描きます。1 コマにつき画像 1 枚で、xAI アカウントに請求されます。描けなかったコマは代わりに撮影します。",
  "This conversation was long, so only its most recent part was read.": "会話が長いため、最近の部分だけを読みました。",
  "Page outfit": "ページの衣装",
  "Scene": "シーン",
  "Action": "動作",
  "Painting with Grok Imagine… %s of %s": "Grok Imagine で作画中… %s / %s",
  "Changing into %s…": "%s に着替え中…",
  "%s panel(s) couldn't be painted, so they're photographed instead.": "%s コマは描けなかったため、代わりに撮影します。",
  "%s scene(s) couldn't be painted and keep the usual backdrop.": "%s コマの背景は描けなかったため、いつもの背景のままです。",
  "Show you in this panel beside %s": "このコマで %s の隣にあなたを描く",
  "with you": "あなたと",
  "Your avatar (optional)": "あなたのアバター（任意）",
  "An avatar that plays you in Manga Diary pages: it stands beside your companion in the photoshoot, and its portrait is your likeness in Imagine-drawn panels.":
    "漫画日記であなたを演じるアバターです。撮影ではコンパニオンの隣に立ち、Imagine で描くコマではそのポートレートがあなたの姿になります。",
  "None: you stay off-panel": "なし（あなたはコマの外）",
  "Main outfit": "メインの衣装",
  "No conversations yet. Talk or chat with a companion first.": "まだ会話がありません。まずコンパニオンと話してみてください。",
  "Format": "形式",
  "Style": "スタイル",
  "Full page (4–6 panels)": "1 ページ（4〜6 コマ）",
  "4-koma strip": "4 コマ漫画",
  "Black & white screentone": "白黒スクリーントーン",
  "Colour": "カラー",
  "Focus (optional)": "焦点（任意）",
  "e.g. the part where we planned the trip": "例: 旅行の計画を立てたところ",
  "Writing the storyboard…": "ネームを作成中…",
  "Write storyboard": "ネームを作る",
  "Rewrite storyboard": "ネームを作り直す",
  "Could not write the storyboard": "ネームを作成できませんでした",
  "Could not load the manga pages": "漫画ページを読み込めませんでした",
  "Start the photoshoot": "撮影を始める",
  "Edit any line before the shoot. %s will pose on the Voice tab; it takes about two seconds a panel.":
    "撮影前にセリフを自由に編集できます。%s がボイスタブでポーズを取ります（1 コマ約 2 秒）。",
  "Pages": "ページ",
  "No pages yet. Your first one is a storyboard away.": "まだページがありません。ネームを作れば 1 ページ目です。",
  "Delete the manga page \"%s\"?": "漫画ページ「%s」を削除しますか？",
  "Could not delete the page": "ページを削除できませんでした",
  "Re-shoot": "撮り直す",
  "Manga photoshoot": "漫画の撮影",
  "Getting %s ready…": "%s の準備中…",
  "Panel %s of %s": "%s / %s コマ",
  "Open in the gallery": "ギャラリーで開く",
  "Close-up": "クローズアップ",
  "Bust shot": "バストショット",
  "Waist shot": "ウエストショット",
  "Full body": "全身",
  "Wide shot": "ロングショット",
  "front": "正面",
  "three-quarter left": "左斜め",
  "three-quarter right": "右斜め",
  "low angle": "あおり",
  "high angle": "俯瞰",
  "dutch angle": "ダッチアングル",
  "The companion's avatar did not load.": "コンパニオンのアバターを読み込めませんでした。",
  "The avatar is busy (walking, dancing or in VR). Try again in a moment.":
    "アバターが使用中です（歩行・ダンス・VR）。少し待ってからもう一度お試しください。",
  "Could not photograph the avatar.": "アバターを撮影できませんでした。",
  "End the call first: your companion can't pose for the manga mid-call.":
    "先に通話を終了してください。通話中は漫画のポーズを取れません。",
  "This companion has no avatar to pose.": "このコンパニオンにはポーズを取るアバターがありません。",
  // Games over the Neuro API (GameIntegrationsView / CompanionsView)
  "Games (Neuro API)": "ゲーム（Neuro API）",
  "Rexclaw speaks the Neuro API, the open protocol behind Neuro-sama's game integrations. Games and mods built on it (Slay the Spire 2, Inscryption, Buckshot Roulette, Hollow Knight and many made by the community) connect here, and companions with \"Games\" switched on (Companions tab) play them: the game tells them what is happening and what they can do, and they make their moves while talking it through with you.":
    "Rexclaw は Neuro-sama のゲーム連携を支えるオープンなプロトコル、Neuro API に対応しています。これに対応したゲームや MOD（Slay the Spire 2、Inscryption、Buckshot Roulette、Hollow Knight、コミュニティ製の多数の MOD）がここに接続し、「ゲーム」をオンにしたコンパニオン（コンパニオンタブ）がプレイします。ゲームが状況とできることを伝え、コンパニオンはあなたと話しながら手を打ちます。",
  "Setup: point the game at this address. Most read it from the NEURO_SDK_WS_URL environment variable, some have a setting of their own. Mods that expect Neuro's default address work untouched once the port below is on.":
    "設定：ゲームにこのアドレスを指定します。多くは環境変数 NEURO_SDK_WS_URL から読み取り、独自の設定項目を持つものもあります。Neuro の既定アドレスを前提とする MOD は、下のポートをオンにすればそのまま動きます。",
  "Best for games played one decision at a time: card games, deck-builders, board games, turn-based roguelikes and visual novels. Fast action games don't work, since every move is a full turn of the model. Each integration is a mod you install into the game; find them at ":
    "一手ずつ進むゲームに向いています：カードゲーム、デッキ構築、ボードゲーム、ターン制ローグライク、ノベルゲーム。1 手ごとにモデルの 1 ターンかかるため、速いアクションゲームには向きません。各連携はゲームに入れる MOD で、入手先は ",
  "the Neuro SDK page": "Neuro SDK のページ",
  "Copy": "コピー",
  "Neuro's default address": "Neuro の既定アドレス",
  "Also listen on ws://localhost:%s (this computer only)": "ws://localhost:%s でも待ち受ける（このパソコンのみ）",
  "Not listening: %s": "待ち受けていません：%s",
  "Who plays a game that doesn't choose for itself, like a Neuro mod. The mini-games ask in their library.":
    "Neuro MOD のように相手を選ばないゲームを誰がプレイするか。ミニゲームは一覧で選びます。",
  "Mods play with": "MOD の相手",
  "%s (first with Games on)": "%s（ゲームがオンの最初のコンパニオン）",
  "Nobody has Games on": "ゲームがオンのコンパニオンなし",
  "What a mod does while you aren't on a call with its companion. Off a call, every move and every reply is one text turn on the companion's brain, billed like a chat message.":
    "相手のコンパニオンと通話していないときの MOD の動作。通話外では、1 手・1 返信ごとにコンパニオンの頭脳で 1 ターン使い、チャットのメッセージと同様に課金されます。",
  "Mods, off a call": "MOD（通話外）",
  "Wait for a call": "通話を待つ",
  "Play in a game chat of its own": "ゲーム専用のチャットでプレイ",
  "Play in our latest conversation (remembered)": "最新の会話でプレイ（記憶される）",
  "waiting for a call": "通話待ち",
  "in a game chat": "ゲーム専用チャット",
  "in your latest conversation": "最新の会話",
  "on a call": "通話中",
  "No companion has \"Games\" switched on yet: turn it on in the Companions tab, under Tools.":
    "「ゲーム」をオンにしたコンパニオンがまだいません。コンパニオンタブのツールでオンにしてください。",
  "Connected games": "接続中のゲーム",
  "Mini-games": "ミニゲーム",
  "The Rexmaw games deck: Broadside! (a 3D cannon duel), chess, heads-up Hold'em, Connect Four, Liar's Dice, Blackjack, Crazy Eights, Walk the Plank, Rock Paper Scissors and Tic-Tac-Toe, each with its own modes, music, sound effects, backdrops, doubloons and streaks, and the crew chiming in. In the library you pick who you play with and what happens off a call, see the crew's standings, and record each companion's reaction lines in their own voice. Every game has a chat box and a speech bubble for talking while you play.":
    "レックスモー号のゲームデッキ：ブロードサイド！（3D の海戦）、チェス、ヘッズアップのホールデム、四目並べ、ライアーズダイス、ブラックジャック、クレイジーエイト、板歩き（ハングマン）、じゃんけん、三目並べ。どれもモード、音楽、効果音、背景、ダブロン金貨、連勝記録付きで、クルーも茶々を入れます。一覧で対戦相手と通話外の動作を選び、クルーの順位を見て、コンパニオンのリアクションを本人の声で録音できます。各ゲームにはプレイ中に話せるチャット欄と吹き出しがあります。",
  "Open the mini-games library": "ミニゲーム一覧を開く",
  "Add your own games": "自作ゲームを追加する",
  "Every game is a folder with a game.json (title, description, tags, cover) beside its pages and assets, so a game can be as big as you like: scripts, sounds, three.js scenes. To add your own outside the app (in a private folder), make it an extension: a folder with plugin.json and __init__.py, placed in data/plugins/ or listed under Settings → Extensions, whose static folder holds the game folders.":
    "各ゲームは、ページや素材と並んで game.json（タイトル・説明・タグ・カバー）を置いたフォルダです。スクリプト、サウンド、three.js のシーンなど、いくらでも大きなゲームにできます。自作のゲームをアプリの外（非公開フォルダ）に追加するには拡張機能にします。plugin.json と __init__.py を含むフォルダを data/plugins/ に置くか 設定 → 拡張機能 に登録し、その静的フォルダにゲームのフォルダを入れます。",
  "A page loads /games/lib/neuro.js, juice.js and lines.js (and games.css for the same look), then calls RexGame.create() with the game's name, rules and actions. Copy any built-in game as a starting point; web/public/games/README.md has the details, three.js included. The games then appear in the library under the extension's name. Keep games for grown-ups in a private extension like this, out of the app's own folder.":
    "ページは /games/lib/neuro.js、juice.js、lines.js（同じ見た目にするなら games.css も）を読み込み、ゲーム名・ルール・アクションを渡して RexGame.create() を呼びます。内蔵ゲームをひな形にコピーしてください。詳細（three.js を含む）は web/public/games/README.md にあります。ゲームは拡張機能の名前の下に一覧表示されます。大人向けのゲームは、このように非公開の拡張機能に入れ、アプリのフォルダには置かないでください。",
  "No game connected. Open a mini-game, or start a game with a Neuro API mod.":
    "接続中のゲームはありません。ミニゲームを開くか、Neuro API 対応 MOD 入りのゲームを起動してください。",
  "Neuro API · %s": "Neuro API · %s",
  "player: %s": "プレイヤー：%s",
  "Waiting on a move": "手番待ち",
  "No actions registered": "登録されたアクションはありません",
  "Games (Neuro API — see the Games tab)": "ゲーム（Neuro API — ゲームタブを参照）",
  "Lets the companion play games that connect to Rexclaw over the Neuro API — mods and games made for Neuro-sama, or the mini-games in the Games tab. The game tells the companion what is happening and what it can do, and the companion makes its moves (game_action, game_status). On calls the tools are there from the start, so a game can connect mid-call; in text chats only while a game is connected.":
    "Neuro API で Rexclaw に接続するゲーム（Neuro-sama 向けの MOD やゲーム、ゲームタブのミニゲーム）をコンパニオンがプレイできるようにします。ゲームが状況とできることを伝え、コンパニオンが手を打ちます（game_action、game_status）。通話では最初からツールがあるので通話中にゲームを接続でき、テキストチャットではゲームの接続中のみ使えます。",
};
