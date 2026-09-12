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
  "Companions talk through your own xAI (Grok) account, which bills you directly for usage.":
    "コンパニオンとの会話にはご自身の xAI（Grok）アカウントを使用し、利用料金は xAI から直接請求されます。",
  "Add your API key in Settings to get started.": "設定で API キーを追加すると使い始められます。",
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
  "Opens this app to every device on your WiFi — VR headsets (Quest, Pico, …), phones and tablets — via the URL below. HTTPS is what makes the full experience work there: browsers only allow the microphone (voice calls) and WebXR on secure origins, so over plain HTTP another device could browse and text-chat but never talk. It also enables installing the app from the phone's browser (Add to Home Screen). Turning it on restarts the app's server in HTTPS mode and reloads this window; on each device, accept the one-time certificate warning, and on the PC allow access if Windows Firewall asks. Takes effect immediately (independent of Save settings).":
    "同じ WiFi 上のあらゆるデバイス — VR ヘッドセット（Quest、Pico など）、スマートフォン、タブレット — から下記の URL でこのアプリを開けるようにします。フル機能が動くのは HTTPS のおかげです：ブラウザはマイク（音声通話）と WebXR をセキュアなオリジンでしか許可しないため、HTTP のままでは他のデバイスから閲覧やテキストチャットはできても会話はできません。スマートフォンのブラウザからのアプリインストール（ホーム画面に追加）も可能になります。オンにするとアプリのサーバーが HTTPS モードで再起動し、このウィンドウが再読み込みされます。各デバイスで初回のみ証明書の警告を承認し、PC 側では Windows ファイアウォールに許可を与えてください。（設定の保存とは独立して）即座に反映されます。",
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
  "Switch to full body (drag to rotate, scroll to zoom)":
    "全身表示に切り替え（ドラッグで回転、スクロールでズーム）",
  "Disable walk mode": "歩行モードを無効化",
  "Enable walk mode (WASD / arrow keys — number keys pick which character to move in a group call)":
    "歩行モードを有効化（WASD／矢印キー — グループ通話中は数字キーで操作キャラを選択）",
  "Hide walk mode settings": "歩行モード設定を隠す",
  "Walk mode settings (mode, reset, position)": "歩行モード設定（モード・リセット・位置）",
  "Walk": "歩行",
  "No snap-back": "スナップバックなし",
  "Moves the companion; faces you again on stop":
    "コンパニオンを移動させます。停止するとあなたの方を向き直します",
  "Same, but leaves it facing however it stopped — for posing":
    "同様ですが、停止した向きのままにします — ポーズ付けに便利です",
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
  "Context management": "コンテキスト管理",
  "Voice summarization threshold (tokens)": "音声の要約しきい値（トークン）",
  "Text summarization threshold (tokens)": "テキストの要約しきい値（トークン）",
  "Recent turns kept verbatim": "そのまま残す直近ターン数",
  "A companion can only hold so much of a conversation in mind at once, so long ones are condensed as they go. Once a conversation has exceeded summarization threshold tokens since its last summary, the older part is boiled down into a short recap and carried forward in its place, while the most recent turns are kept word for word. Your companion keeps the gist of everything that came before, and the immediate thread stays sharp. Mid-call this happens during a natural pause, so it never interrupts you. Long-term memory and the full transcript stay accessible either way — condensed conversations are stored as episodes your companion can look up again with its recall tool.":
    "コンパニオンが一度に把握できる会話量には限りがあるため、長い会話は進行に合わせて圧縮されます。前回の要約以降、会話が要約しきい値のトークン数を超えると、古い部分は短い要約にまとめられてその代わりに引き継がれ、直近のやり取りはそのままの言葉で保持されます。これにより、コンパニオンはそれまでの流れの要点を保ちつつ、目の前の話題を鮮明に把握できます。通話中は会話の自然な区切りで実行されるため、話の邪魔になることはありません。長期記憶と全文の記録はいずれの場合もアクセス可能です — 圧縮された会話はエピソードとして保存され、コンパニオンは recall ツールで再び参照できます。",
  "How many of the newest messages are left out of the recap and carried forward word for word.":
    "要約に含めず、そのままの言葉で引き継ぐ直近メッセージの件数です。",
  "Transcript messages shown on resume": "再開時に表示するメッセージ数",
  "Most-recent messages loaded into the transcript when a conversation is resumed; 0 shows everything. Older messages stay stored — this only affects what is painted on screen, not what the companion remembers.":
    "会話を再開したときにトランスクリプトへ読み込む直近メッセージの件数です。0 ですべて表示します。古いメッセージも保存されたままで、画面に描画される範囲だけが変わり、コンパニオンの記憶には影響しません。",

  // ── Settings: cost optimization ───────────────────────────────────────
  "Cost optimization": "コスト最適化",
  "When you resume a conversation, its history is sent to xAI to restore the companion's memory of it — and xAI charges per message sent, about $0.004 each, no matter how short. A long relationship costs real money to pick up again: a 250-message conversation is about $1 every single time you resume it. That count is not your whole history, though — every summarization resets it, since the messages it condenses replay as a single recap. Only what has built up since the last summary is sent message by message — so the costliest moment to resume is just before a summary is due, when that backlog is at its largest.":
    "会話を再開すると、コンパニオンの記憶を戻すために履歴が xAI に送信されます。xAI は送信されたメッセージ 1 件ごとに、長さに関係なく約 $0.004 を課金します。長い関係を再開するには実際にコストがかかります — 250 メッセージの会話なら、再開するたびに約 $1 です。ただし、この件数は会話の全履歴ではありません。要約が行われるたびにこの件数はリセットされ、まとめられたメッセージは 1 件の要約として再送されるためです。1 件ずつ送信されるのは、前回の要約以降に積み上がった分だけです — したがって、再開のコストが最も高くなるのは、次の要約が行われる直前、この蓄積が最大になっているタイミングです。",
  "Rolling up the history bundles the older messages into one single message instead of hundreds, taking that $1 down to under a cent. Nothing is deleted or summarised — every word is still sent, word for word. What changes is the shape: the bundled part arrives as one transcript rather than as separate turns, so your companion may recall it a little less sharply than the turns kept whole below. Recent turns are what matter most for staying in character, which is why they are left untouched.":
    "履歴をまとめると、古いメッセージが数百件ではなく 1 件にまとめられ、この約 $1 が 1 セント未満になります。削除も要約もされず、すべての語句がそのまま送信されます。変わるのは形です — まとめられた部分は個別のやり取りではなく 1 つの記録として届くため、下で指定してそのまま残すターンよりも、コンパニオンの記憶がやや曖昧になる可能性があります。直近のやり取りはキャラクターを保つうえで最も重要なため、手を加えずに残されます。",
  "Recommended if you dip in and out of a conversation for quick exchanges: short, frequent resumes are where replaying the history dominates the bill. On long calls it matters much less, because the per-minute charge for the call itself outweighs it.":
    "短いやり取りのために会話を頻繁に開いたり閉じたりする場合におすすめです。短時間の再開を繰り返す使い方では、履歴の再送が料金の大部分を占めます。長時間の通話では、通話自体の分単位の料金の方が大きいため、影響はずっと小さくなります。",
  "Roll up older history when resuming a conversation":
    "会話の再開時に古い履歴をまとめる",
  "Recent turns kept whole": "そのまま残す直近ターン数",
  "How many of the most recent messages stay as separate turns, exactly as they are sent today. Everything older is bundled. Higher keeps more of the conversation's natural shape and costs a little more; 0 bundles everything.":
    "直近の何件のメッセージを、現在と同じように個別のやり取りとして送信するかを指定します。それより古いものはまとめられます。大きくすると会話の自然な形がより多く保たれますが、コストはわずかに増えます。0 にするとすべてまとめられます。",
  "A call bills for as long as it stays connected, whether or not anyone is talking — so the expensive mistake is walking away from one. Rexclaw can hang up for you after a stretch with nothing happening: nobody spoke or typed, no companion took a turn, no tool ran. Muting does not count as leaving, and a companion mid-sentence is never cut off. The conversation is only ended, never lost — resuming picks it straight back up. xAI drops a call at 15 minutes regardless, so anything longer than that would never get the chance to fire. 0 turns it off.":
    "通話は接続している間ずっと課金され、誰かが話しているかどうかは関係ありません — つまり、通話をそのままにして離席することが最も高くつきます。Rexclaw は、何も起きない状態が続いたあと自動的に通話を終了できます。誰も話さず、入力もせず、コンパニオンの発言もツールの実行もない状態が対象です。ミュートは離席とはみなされず、発言の途中でコンパニオンが打ち切られることもありません。会話は終了されるだけで失われることはなく、再開すればそのまま続きから始まります。なお xAI は 15 分で通話を切断するため、それより長い値を設定しても発動する機会はありません。0 で無効になります。",
  "End the call after this many idle minutes": "この分数だけ何も起きなければ通話を終了",

  // ── Settings: hotkeys ─────────────────────────────────────────────────
  "Hotkeys": "ホットキー",
  "Click a shortcut to record a new one, then press the keys you want. Backspace clears it, Escape keeps what was there. Shortcuts apply once you save.":
    "ショートカットをクリックしてから使いたいキーを押すと登録されます。Backspace で解除、Escape で変更を取り消します。ショートカットは保存すると有効になります。",
  "Use these shortcuts system-wide (desktop app)":
    "これらのショートカットをシステム全体で使う（デスクトップアプリ）",
  "System-wide shortcuts work while you are in another application — which is the point of the desktop avatar: it floats on top unfocused, so shortcuts it can only see when focused would rarely fire. The cost is that these key combinations stop reaching every other program while Rexclaw runs. Turn this off to have them work only while a Rexclaw window has focus. On some keyboard layouts Ctrl+Alt is how AltGr characters are typed — pick different keys if typing breaks elsewhere.":
    "システム全体のショートカットは、他のアプリを使っている間でも動作します。デスクトップアバターはフォーカスされないまま最前面に浮かんでいるため、フォーカス時にしか反応しないショートカットではほとんど役に立ちません。その代わり、Rexclaw の起動中はこれらのキーの組み合わせが他のすべてのプログラムに届かなくなります。オフにすると、Rexclaw のウィンドウにフォーカスがあるときだけ動作します。一部のキーボードレイアウトでは Ctrl+Alt が AltGr の入力に使われます — 他のアプリで入力がおかしくなる場合は別のキーを選んでください。",
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
  "Start a call hands-free: with standby listening on, the microphone stays open while no call is live, and saying a companion's wake phrase (set per companion on the Companions tab — e.g. \"hey Eve\") starts one. Detection runs entirely on this machine with a small offline speech model — nothing is sent to xAI and nothing is billed until a call actually starts. The trade-off is an always-on microphone (your OS will show its mic indicator) and the one-time model download below. A soft chime confirms every wake.":
    "ハンズフリーで通話を開始できます。スタンバイリスニングを有効にすると、通話していない間もマイクが開いたままになり、コンパニオンのウェイクフレーズ（Companions タブでコンパニオンごとに設定 — 例：「ヘイ、イヴ」）を言うと通話が始まります。検出はこのマシン上の小さなオフライン音声モデルだけで行われます — 通話が実際に始まるまで、xAI には何も送信されず、課金も発生しません。その代わり、マイクが常時オンになり（OS のマイクインジケーターが表示されます）、下記のモデルを一度ダウンロードする必要があります。ウェイクのたびに小さなチャイムが鳴って確認できます。",
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
  "Mascot mode is the pop-out avatar: a small transparent always-on-top window with no app chrome around it. Start there and Rexclaw opens as the companion on your desktop rather than as an application window — the full window is still one \"pop back in\" away, from the avatar's controls or the tray icon. Takes effect on the next launch (independent of Save settings).":
    "マスコットモードとは、ポップアウトしたアバターのことです。アプリの枠がない、小さく透明な最前面ウィンドウとして表示されます。これを有効にすると、Rexclaw はアプリウィンドウではなくデスクトップ上のコンパニオンとして起動します。通常のウィンドウには、アバターの操作パネルかトレイアイコンから「戻す」だけでいつでも切り替えられます。次回の起動から反映されます（「設定を保存」とは独立して適用されます）。",
  "Open in mascot mode": "マスコットモードで起動する",
  "Hide the avatar between calls": "通話していない間はアバターを隠す",
  "In mascot mode, the avatar disappears from the desktop while no call is live and pops back up (without stealing focus) when one starts. Pairs naturally with voice activation: the companion waits dormant and appears when you call their wake phrase. While hidden, the tray icon is the way back — click it or its \"Show Rexclaw\" entry.":
    "マスコットモードで、通話していない間はアバターがデスクトップから消え、通話が始まると（フォーカスを奪わずに）再び現れます。音声起動と自然に組み合わせられます：コンパニオンは裏で待機し、ウェイクフレーズを呼ぶと現れます。非表示の間はトレイアイコンが戻る手段です — アイコンをクリックするか「Show Rexclaw」を選んでください。",
  "The mascot's own options — call controls, ghost mode, cursor follow, emotions and more — live in its settings window: the ⚙ on the avatar's controls, or \"Full mascot settings\" in the tray menu.":
    "マスコット自体のオプション — 通話操作、ゴーストモード、カーソル追従、感情など — は専用の設定ウィンドウにあります。アバターの操作パネルの ⚙、またはトレイメニューの「Full mascot settings」から開けます。",
  "Could not save that.": "保存できませんでした。",

  // ── Mascot settings window ────────────────────────────────────────────
  "Mascot settings": "マスコット設定",
  "Open mascot settings": "マスコット設定を開く",
  "Everything about the desktop avatar in one place. Changes apply immediately.":
    "デスクトップアバターに関する設定をここにまとめました。変更は即時に反映されます。",
  "The desktop mascot is part of the desktop app — open this window from there.":
    "デスクトップマスコットはデスクトップアプリの機能です — このウィンドウはそちらから開いてください。",
  "The avatar isn't popped out right now — everything except Visibility & startup comes alive when it is.":
    "アバターは今ポップアウトされていません — 「表示と起動」以外の設定はポップアウトすると有効になります。",
  "Pop out avatar": "アバターをポップアウト",
  "Emotions & gestures": "感情とジェスチャー",
  "Companion & call": "コンパニオンと通話",
  "Share screen": "画面共有",
  "Pop back in": "アプリウィンドウに戻す",
  "Transcript window": "トランスクリプトウィンドウ",
  "Manual triggers, same as the full-screen view — they play on the desktop avatar right away, call or no call.":
    "フルスクリーンビューと同じ手動トリガーです — 通話の有無にかかわらず、デスクトップのアバターで即座に再生されます。",
  "Behavior": "動作",
  "Ghost mode": "ゴーストモード",
  "Clicks pass through the window to whatever is behind it, and the avatar fades out of the cursor's way. The controls island stays clickable.":
    "クリックはウィンドウを素通りして背後のアプリに届き、アバターはカーソルを避けてフェードします。操作パネルはクリック可能のままです。",
  "Follow the cursor": "カーソルを追う",
  "Eyes and head track your mouse across the desktop; when it rests, they return to eye contact.":
    "目と頭がデスクトップ上のマウスを追いかけます。マウスが止まるとアイコンタクトに戻ります。",
  "Keep the avatar above every other window, fullscreen apps included.":
    "アバターを常に他のすべてのウィンドウ（フルスクリーンアプリ含む）の前面に表示します。",
  "Full body view": "全身ビュー",
  "Show the whole character instead of the face view — drag rotates, scroll zooms.":
    "顔のアップではなく全身を表示します — ドラッグで回転、スクロールでズーム。",
  "Look": "見た目",
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
  "None (keep current)": "なし（現在の設定を維持）",
  "Lighting preset selected whenever this background is switched to. Leave blank to keep the current selection.":
    "この背景に切り替えたときに選択されるライティングプリセット。空欄なら現在の選択を維持します。",
  "Pre-set light rigs — a key light, a coloured rim from behind and, on most of them, a soft shadow under the feet. Also applies to the full-screen view.":
    "プリセットの照明 — キーライト、背後からの色付きリムライト、多くのプリセットでは足元のやわらかい影。フルスクリーン表示にも適用されます。",
  "Touch physics": "タッチ物理",
  "Hair, skirts and other swinging parts move out of the cursor's way, ruffle with quick mouse sweeps, and bounce when clicked.":
    "髪やスカートなどの揺れる部分がカーソルを避けて動き、素早いマウス操作でなびき、クリックすると弾みます。",
  "Window size": "ウィンドウサイズ",
  "Or scroll on the avatar (face view) for fine control.":
    "アバター上でスクロールしても微調整できます（フェイスビュー時）。",
  "Outfit": "衣装",
  "Placement": "配置",
  "Snap to corner": "コーナーに配置",
  "Next monitor": "次のモニターへ",
  "Visibility & startup": "表示と起動",
  "Hide avatar controls": "アバターの操作パネルを隠す",
  "The floating controls island never shows, even on hover. The tray menu and hotkeys stay available — including this window.":
    "フローティング操作パネルをホバーしても一切表示しません。トレイメニューとホットキー（このウィンドウを含む）は引き続き使えます。",
  "Rexclaw starts as the companion on your desktop instead of an app window. Takes effect on the next launch.":
    "Rexclaw がアプリウィンドウではなくデスクトップ上のコンパニオンとして起動します。次回の起動から反映されます。",
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
  "Avatar": "アバター",
  "(no avatar)": "（アバターなし）",
  "Reasoning effort (text mode)": "推論エフォート（テキストモード）",
  "System prompt": "システムプロンプト",
  "Computed voice prompt (read-only)": "算出されたボイスプロンプト（読み取り専用）",
  "Exactly what a solo voice session receives: the environment preamble, the saved system prompt, and the dynamic tool/expression/memory sections. Computed from the last saved state; unsaved edits above are not included.":
    "ソロボイスセッションが受け取る内容そのものです：環境プリアンブル、保存済みシステムプロンプト、動的なツール・表現・メモリのセクション。最後に保存した状態から算出されるため、上の未保存の編集は含まれません。",
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
  "Provider": "プロバイダー",
  "Provider tools": "プロバイダーツール",
  "Grok (xAI)": "Grok（xAI）",
  "The LLM backend this companion runs on. Only Grok (xAI) is available today.":
    "このコンパニオンを動かす LLM バックエンド。現在は Grok（xAI）のみ利用できます。",
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
  "Lets the companion look up its lore stories on demand. Only offered when at least one story below is tagged with the companion's name.":
    "コンパニオンが必要に応じてロアストーリーを参照できるようにします。下のストーリーにコンパニオンの名前がタグ付けされている場合にのみ提供されます。",
  "Built-in xAI voice names such as ara work as-is. For a custom voice, create or clone one in the xAI console (console.x.ai) and paste its voice id here.":
    "ara などの xAI 組み込みボイス名はそのまま使えます。カスタムボイスは xAI コンソール（console.x.ai）で作成またはクローンし、そのボイス ID をここに貼り付けてください。",
  "Fast text model (delegate tool)":
    "高速テキストモデル（委任ツール）",
  "Quicker, shallower text model that delegate_task can pick with model='fast' for looking at images, screenshots and clips or reading short documents. Empty = same as the Text model.":
    "delegate_task が model='fast' で選べる、より速く浅いテキストモデルです。画像やスクリーンショット、クリップの確認、短い文書の読み取りに使います。空欄 = テキストモデルと同じ。",
  "Manage keys, usage and custom voices in the":
    "API キー、使用量、カスタムボイスの管理は",
  "xAI console":
    "xAI コンソール",
  "Model rates:":
    "モデル料金：",
  "Capture tools (selfie & screen share)":
    "キャプチャツール（自撮り＆画面共有）",
  "Lets the companion take a photo of itself when you ask (take_selfie: the live avatar in calls, its portrait in chat) and, once you've shared your screen, grab screenshots or short clips of it (take_screenshot, record_screen_clip). Captures land in the files library for the transcript and for other tools to use. Nothing is generated, so this works with any provider.":
    "頼まれたときにコンパニオンが自分の写真を撮れるようにします（take_selfie — 通話中はライブのアバター、チャットではポートレート）。また、画面共有を開始していれば、そのスクリーンショットや短いクリップを取得できます（take_screenshot、record_screen_clip）。キャプチャはファイルライブラリに保存され、トランスクリプトや他のツールから利用できます — 何も生成しないため、どのプロバイダーでも使えます。",
  "Image & video tools": "画像・動画ツール",
  "Unlocks the media tools: create_image and create_video (from a prompt, or remixing images in the Imagine library: selfies, screenshots and your uploads), plus in voice calls change_background (generate a new scene behind the avatar). Each tool renders on Grok Imagine (billed by xAI: images cost cents, videos are priced per second) or on your own ComfyUI server. Pick the engine per tool in Settings → Local generation.":
    "メディアツールを有効にします：create_image と create_video（プロンプトから、または Imagine ライブラリの画像（セルフィー、スクリーンショット、アップロード）をリミックス）、さらに音声通話では change_background（アバターの背後に新しいシーンを生成）。各ツールは Grok Imagine（xAI が課金：画像は数セント、動画は秒単位）か、自分の ComfyUI サーバーで実行されます。エンジンはツールごとに 設定 → ローカル生成 で選びます。",
  "Cross-companion Imagine reference": "コンパニオン間 Imagine 参照",
  "Lets create_image/create_video feature ANOTHER companion by name (and outfit) — their own portrait as a reference image, and (create_video) their own voice id so a clip can have them speak in their actual voice too. Separate from Companion texting on purpose: a companion can be messageable without being depicted this way, or vice versa. Requires Image & video tools.":
    "create_image／create_video で、名前（と衣装）を指定して「別の」コンパニオンを登場させられるようにします — 参照画像としてその人自身のポートレート、そして（create_video では）実際の声で話させるためのその人自身のボイス ID も使えます。「コンパニオンテキスト」とは意図的に別設定です：テキストは送れても、この形で登場させたくない（またはその逆の）コンパニオンがいてもよいためです。画像・動画ツールが必要です。",
  "xAI pricing":
    "xAI 料金",
  "Lets the companion animate its avatar during voice calls: play gestures (the built-in set plus the avatar's custom ones) and switch between the avatar's outfits (play_gesture, change_outfit). Facial expressions are always available regardless. Unlocks the expression-style notes below.":
    "音声通話中にコンパニオンがアバターを動かせるようにします：ジェスチャーの再生（組み込みセットとアバター固有のカスタムジェスチャー）と、アバターの衣装の切り替え（play_gesture、change_outfit）。表情はこの設定に関係なく常に使えます。下の表現スタイル欄が有効になります。",
  "Lets the companion bring other companions into the current voice call and send them away again (add_agent_to_call, remove_agent_from_call), e.g. when you ask to talk to someone else or want a group conversation. Voice mode only.":
    "コンパニオンが現在の音声通話に他のコンパニオンを呼び入れたり退出させたりできるようにします（add_agent_to_call、remove_agent_from_call）— 別のコンパニオンと話したいときやグループ会話をしたいときに。ボイスモードのみ。",
  "Lets the companion send an async text to another companion and get their reply back, mid voice call or chat — e.g. checking in on someone or passing along news. The message lands in the other companion's own conversation, clearly marked as coming from a companion rather than you. One reply per text; it doesn't turn into an unsupervised back-and-forth.":
    "コンパニオンが、音声通話やチャットの最中に別のコンパニオンへ非同期でテキストを送り、返信を受け取れるようにします — 例えば様子を伺ったり近況を伝えたりする用途です。メッセージは相手コンパニオン自身の会話に届き、あなたではなくコンパニオンからのものだと明確に分かるようになっています。返信は1通のみで、際限のない自動応酬にはなりません。",
  "Gives the companion long-term memory tools (remember, recall, forget): it can save facts about you and your conversations, search them later, and delete ones you ask it to drop. Memories persist across sessions and appear in the Memories tab.":
    "コンパニオンに長期記憶ツール（remember、recall、forget）を与えます：あなたや会話についての事実を保存し、後で検索し、頼まれたものを削除できます。メモリはセッションをまたいで保持され、メモリタブに表示されます。",
  "Lets the companion drive the Minecraft bot set up in the Games tab from voice and text sessions: give it goals and commands, check what it's doing. The tools are only offered while the bot sidecar is connected.":
    "ゲームタブで設定した Minecraft ボットをコンパニオンが操作できるようにします — 目標や指示を出したり状況を確認したり — ボイス／テキストの両セッションから。ツールはボットのサイドカーが接続されている間のみ提供されます。",
  "Lets the companion end the voice call itself (end_call) when you say goodbye or ask it to hang up, instead of waiting for you to press the button. Voice mode only.":
    "あなたが別れを告げたり切るよう頼んだりしたとき、ボタンを押すのを待たずにコンパニオン自身が通話を終了できるようにします（end_call）。ボイスモードのみ。",
  "Lets the companion search the web for current information (news, facts, prices) in both voice and text sessions. Searches are billed by xAI per call.":
    "コンパニオンがボイス／テキストの両セッションで最新情報（ニュース、事実、価格など）をウェブ検索できるようにします。検索は xAI により 1 回ごとに課金されます。",
  "Lets the companion search posts on X (Twitter) in both voice and text sessions. Searches are billed by xAI per call.":
    "コンパニオンがボイス／テキストの両セッションで X（Twitter）の投稿を検索できるようにします。検索は xAI により 1 回ごとに課金されます。",
  "Lets the companion run Python in xAI's sandboxed code interpreter to calculate, analyse data or test snippets. Text sessions only; the voice model has no code tool.":
    "コンパニオンが xAI のサンドボックス化されたコードインタープリタで Python を実行し、計算やデータ分析、スニペットのテストを行えるようにします。テキストセッションのみ — ボイスモデルにはコードツールがありません。",
  "Lets the companion hand complex work (reading documents or images, research, long coding tasks) to a hidden background text session with the full tool stack, and report the result back. Works from voice calls too, where the realtime model can't see files itself. Quick looks at images and clips can run on the fast text model set in Settings. Each task is billed as extra text-model usage.":
    "文書や画像の読み取り、リサーチ、長いコーディング作業などの複雑な仕事を、フルツール構成の非表示のバックグラウンドテキストセッションに任せ、結果を報告させられるようにします。リアルタイムモデル自身がファイルを見られない音声通話からも使えます。タスクごとにテキストモデルの追加使用量として課金されます。",
  "Allows delegated tasks to run on xAI's multi-agent model (several coordinated agents on one task) when the companion asks for it. Noticeably more expensive per task than a plain delegation; requires Task delegation.":
    "コンパニオンが求めた場合に、委任タスクを xAI のマルチエージェントモデル（1 つのタスクに複数のエージェントが連携）で実行できるようにします。通常の委任よりタスクあたりのコストが明らかに高くなります。タスク委任が必要です。",
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
  "None configured. An MCP server gives this companion extra tools; xAI connects to it directly, so the URL must be public HTTPS.":
    "未設定です。MCP サーバーはこのコンパニオンにツールを追加します。xAI が直接接続するため、URL は公開 HTTPS である必要があります。",
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
  "No sessions yet — start a conversation on the Voice or Chat tab.":
    "まだセッションはありません — ボイスまたはチャットタブで会話を始めましょう。",
  "No sessions match your filters.": "条件に一致するセッションはありません。",
  "Could not load sessions": "セッションを読み込めませんでした",
  "Could not load the transcript": "トランスクリプトを読み込めませんでした",
  "Read transcript": "トランスクリプトを読む",
  "Hide transcript": "トランスクリプトを隠す",
  "Resume this session": "このセッションを再開",
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
  "Bot brain model (empty = grok-4.20-non-reasoning)":
    "ボットの頭脳モデル（空欄 = grok-4.20-non-reasoning）",
  "Hard-task model for big jobs (empty = disabled)":
    "大きな仕事用のハードタスクモデル（空欄 = 無効）",
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
  "Raises a sample notification right now, so you can check that Windows shows them for this app.":
    "今すぐサンプル通知を出して、Windows がこのアプリの通知を表示するか確認できます。",
  "Notifications are working. A companion's message will look like this.":
    "通知は動作しています。コンパニオンからのメッセージはこのように表示されます。",
  "This system reports no notification support.": "このシステムは通知に対応していないと報告しています。",
  "Heartbeats that write to you can raise a system notification when they run, even while Rexclaw sits in the tray or behind other windows. Clicking it opens the chat with that companion. Only heartbeats with 'Notify me when it runs' ticked take part, so a diary stays quiet. Requires notifications to be on in Windows Settings › System › Notifications (and off Do Not Disturb).":
    "あなた宛てに書くハートビートは、Rexclaw がトレイや他のウィンドウの後ろにあっても、実行時にシステム通知を出せます。クリックするとそのコンパニオンとのチャットが開きます。「実行時に通知する」にチェックしたハートビートだけが対象なので、日記は静かなままです。Windows の設定 › システム › 通知で通知がオンになっている必要があります（応答不可はオフに）。",
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

  // ── Settings / mascot: background avatar motion ───────────────────────
  "Background Avatar Motion": "アバターの自動モーション",
  "Extra body language on top of the avatar's own gesture set, picked up in the background.":
    "アバター本来のジェスチャーに加えて、自動で拾われる body language です。",
  "Automated background gestures while speaking (experimental)":
    "発話中の自動ジェスチャー（実験的）",
  "Your companion gestures along with what they're saying: a bow for thanks, a shrug for \"oh well\". Each sentence is matched by the turn director model set below, so it adds a little to your usage.":
    "コンパニオンが話している内容に合わせてジェスチャーします。お礼にはお辞儀、「まあいいか」には肩をすくめる、といった具合です。文ごとに下のターンディレクターモデルが選ぶため、その分の利用量が少し増えます。",
  "Your companion gestures along with what they're saying. Each sentence is matched by the turn director model, so it adds a little to your usage.":
    "コンパニオンが話している内容に合わせてジェスチャーします。文ごとにターンディレクターモデルが選ぶため、その分の利用量が少し増えます。",
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
};
