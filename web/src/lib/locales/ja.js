// Japanese UI dictionary. Keys are the English source strings passed to _t()
// — a missing key falls back to English, so partial coverage degrades
// gracefully. Model-facing strings (the "[System]:" call notes injected into
// the LLM context) are deliberately NOT translated: what the model receives
// stays English regardless of the UI language.
export const JA = {
  // ── App chrome ────────────────────────────────────────────────────────
  "Voice": "ボイス",
  "Chat": "チャット",
  "Memories": "メモリ",
  "Settings": "設定",
  "Immersive": "没入モード",
  "Immersive view — hide all UI for a full-screen avatar (H · Esc to exit)":
    "没入ビュー — UI をすべて隠してアバターを全画面表示（H で切替 · Esc で終了）",
  "Immersive view — hide all UI (H · Esc to exit)":
    "没入ビュー — UI をすべて隠す（H で切替 · Esc で終了）",

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
  "Type a message…": "メッセージを入力…",
  "Upload failed": "アップロードに失敗しました",
  "Save failed": "保存に失敗しました",
  "Delete failed": "削除に失敗しました",
  "unknown": "不明",
  "unknown error": "不明なエラー",

  // ── Voice view ────────────────────────────────────────────────────────
  "No previous sessions yet.": "まだセッション履歴はありません。",
  "Hide history": "履歴を隠す",
  "Show history": "履歴を表示",
  "Switch to face view": "顔アップ表示に切り替え",
  "Switch to full body (drag to rotate, scroll to zoom)":
    "全身表示に切り替え（ドラッグで回転、スクロールでズーム）",
  "Disable walk mode": "歩行モードを無効化",
  "Enable walk mode (WASD / arrow keys — number keys pick which character to move in a group call)":
    "歩行モードを有効化（WASD／矢印キー — グループ通話中は数字キーで操作キャラを選択）",
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
  "Light theme": "ライトテーマ",
  "Dark theme": "ダークテーマ",
  "Attach a file": "ファイルを添付",
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

  // ── Settings: connection / models ─────────────────────────────────────
  "Could not load settings": "設定を読み込めませんでした",
  "Could not load companions": "コンパニオンを読み込めませんでした",
  "Settings saved.": "設定を保存しました。",
  "xAI connection": "xAI 接続",
  "API key": "API キー",
  "saved": "保存済み",
  "•••••••• (leave blank to keep current key)": "••••••••（空欄のままなら現在のキーを維持）",
  "Voice model": "音声モデル",
  "Text model": "テキストモデル",
  "Summary model": "要約モデル",
  "Imagine model": "Imagine モデル",
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
  "Include my name in the system prompt (sent to xAI — off by default)":
    "システムプロンプトに自分の名前を含める（xAI に送信されます — デフォルトはオフ）",

  // ── Settings: context management ──────────────────────────────────────
  "Context management": "コンテキスト管理",
  "Voice summarization threshold (tokens)": "音声の要約しきい値（トークン）",
  "Text summarization threshold (tokens)": "テキストの要約しきい値（トークン）",
  "Recent turns kept verbatim": "そのまま残す直近ターン数",

  // ── Settings: companions ──────────────────────────────────────────────
  "Companions": "コンパニオン",
  "Restore presets": "プリセットを復元",
  "Re-create any deleted preset companions (Eve, Ara, Rex, Sal, Leo) with their original prompts. Existing companions are untouched.":
    "削除したプリセットコンパニオン（Eve・Ara・Rex・Sal・Leo）を元のプロンプトで再作成します。既存のコンパニオンには影響しません。",
  "New companion": "新しいコンパニオン",
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
  "When to call (shown to other companions for group calls)":
    "呼ぶタイミング（グループ通話で他のコンパニオンに表示）",
  "Shown to OTHER companions inside their add_agent_to_call tool so they know when to bring this companion into a live group call. Leave empty and other companions only see the name.":
    "他のコンパニオンの add_agent_to_call ツール内に表示され、このコンパニオンをいつ通話に呼ぶべきかの判断材料になります。空欄の場合、他のコンパニオンには名前のみが表示されます。",
  "e.g. 'Sales specialist — call for pricing, quotes, or negotiation roleplay.'":
    "例：「営業スペシャリスト — 価格・見積もり・交渉ロールプレイのときに呼んでください。」",

  // Agent flags
  "Voice mode": "音声モード",
  "Text mode": "テキストモード",
  "Avatar control tools": "アバター操作ツール",
  "Call-companion tool (group calls)": "コンパニオン呼び出しツール（グループ通話）",
  "Web search": "Web 検索",
  "X search": "X 検索",
  "Grok Imagine": "Grok Imagine",
  "Memory": "メモリ",
  "Code execution (text)": "コード実行（テキスト）",

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
  "New avatar": "新しいアバター",
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
  "Placement of the GLB scene, in metres (avatar ≈ 1.5 m tall). Scale, X/Y/Z offset, and Y-axis rotation in degrees.":
    "GLB シーンの配置（メートル単位、アバターは約 1.5 m）。スケール、X/Y/Z オフセット、Y 軸回転（度）。",
  "default": "デフォルト",
  "Save avatar": "アバターを保存",

  // ── Sessions tab ──────────────────────────────────────────────────────
  "Sessions": "セッション",
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
  "Squat": "スクワット",
};
