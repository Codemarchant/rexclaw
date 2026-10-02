# Copyright 2026 Codemarchant
"""Brain engines: a streamed reply with tool calls, from the conversation
the realtime protocol built up (see session.py for the item shapes)."""
import json
import logging
import mimetypes
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

from .engines import (API_KEY, OPENAI_CLOUD_KEY, OPENAI_CLOUD_URL, OPENAI_URL, SERVES, Field, LlmEngine,
                      conversation_fields, json_field)

_logger = logging.getLogger(__name__)

# Output items for the searches xAI runs inside one request (xai_client's
# watchdog: max_turns is not enforced, and a looping search once ran 644
# calls in one reply).
_SEARCH_ITEM_TYPES = frozenset(('web_search_call', 'x_search_call'))

# A server refusing a request because the model (or the server as started)
# can't call tools. From AIRI's list (moeru-ai/airi, MIT,
# packages/core-agent/src/runtime/llm-service.ts), minus its schema and bad-
# call errors, which are a tool's fault rather than the model's, plus
# llama-server without --jinja and vLLM without a tool parser.
_NO_TOOLS_RE = re.compile(
    r'does not support tools'                          # Ollama
    r'|no endpoints found that support tool use'       # OpenRouter
    r'|functions are not supported'                    # Azure AI Foundry
    r'|unrecognized request argument.+tools'           # Azure AI Foundry
    r'|tool use with function calling is unsupported'  # Google
    r'|does not support function.?calling'             # Anthropic
    r'|tools?\s+(is|are)\s+not\s+supported'            # Cloudflare Workers AI
    r'|requires --jinja'                               # llama.cpp llama-server
    r'|enable-auto-tool-choice',                       # vLLM
    re.IGNORECASE)


def item_text(item):
    """The words of a realtime message item, whatever its content types."""
    parts = []
    for part in item.get('content') or []:
        if not isinstance(part, dict):
            continue
        text = part.get('text')
        if text is None:
            text = part.get('transcript')
        if text:
            parts.append(text)
    return ''.join(parts).strip()


def _kind(item):
    """An item's type; text chat's Responses-style messages carry only a role."""
    return item.get('type') or ('message' if item.get('role') else None)


def _answered_calls(items):
    """call_ids that have both their call and its output in the conversation.
    A call still running has no output yet, and an output can outlive its
    call (a compacted history): either half alone is rejected by the APIs,
    so those travel as plain notes instead."""
    calls = {i.get('call_id') for i in items if i.get('type') == 'function_call'}
    outputs = {i.get('call_id') for i in items if i.get('type') == 'function_call_output'}
    return calls & outputs


def _note_for(item):
    if item.get('type') == 'function_call':
        return f"[Tool call] {item.get('name') or 'tool'}({item.get('arguments') or ''})"
    return f"[Tool result] {item.get('output') or ''}"


def _sse_events(lines):
    """Parse an httpx line iterator of server-sent events into dicts."""
    async def gen():
        async for line in lines:
            if not line or not line.startswith('data:'):
                continue
            data = line[5:].strip()
            if not data or data == '[DONE]':
                continue
            try:
                yield json.loads(data)
            except ValueError:
                continue
    return gen()


class LlmError(RuntimeError):
    pass


class SearchLimit(LlmError):
    """The provider's own search loop ran past the app's per-reply limit
    (Settings: text_max_searches); the caller answers again without the
    search tools."""


class _Refused(LlmError):
    """An HTTP error answer, with its body, for a caller that retries
    without an option the model refuses."""

    def __init__(self, message, body):
        super().__init__(message)
        self.body = body


def _media_parts(item):
    """A user message's input_image / input_file parts (text chat's
    attachments, see session_service.attachment_part): inline (image_url
    data URL, file_data) or uploaded to the provider (file_id)."""
    return [p for p in item.get('content') or []
            if isinstance(p, dict) and p.get('type') in ('input_image', 'input_file')
            and (p.get('image_url') or p.get('file_data') or p.get('file_id'))]


def _responses_input(items, vision=False, tool_names=None):
    """Responses-API input from realtime items. A user message keeps its
    files as content parts (text chat attaches only the ones the brain
    reads), and its images with `vision`. With `tool_names`, only calls of
    a function the request declares replay as function_call items; others
    (a provider's own search or MCP call, recorded as a tool row) as notes,
    like _claude_messages."""
    answered = _answered_calls(items)
    if tool_names is not None:
        answered &= {it.get('call_id') for it in items
                     if it.get('type') == 'function_call' and it.get('name') in tool_names}
    out = []
    for it in items:
        kind = _kind(it)
        if kind == 'message':
            text = item_text(it)
            role = it.get('role') or 'user'
            media = [p for p in _media_parts(it) if not p.get('sandbox')
                     and (p['type'] == 'input_file' or vision)] if role == 'user' else []
            if media:
                out.append({'role': role, 'content': ([{'type': 'input_text', 'text': text}] if text else [])
                            + [dict(p) for p in media]})
            elif text:
                out.append({'role': role, 'content': text})
        elif kind in ('function_call', 'function_call_output'):
            if it.get('call_id') not in answered:
                out.append({'role': 'system', 'content': _note_for(it)})
            elif kind == 'function_call':
                out.append({'type': 'function_call', 'call_id': it['call_id'],
                            'name': it.get('name') or '', 'arguments': it.get('arguments') or '{}'})
            else:
                out.append({'type': 'function_call_output', 'call_id': it['call_id'],
                            'output': it.get('output') or ''})
    return out


def _responses_server_call(item):
    """A search or code run the provider did inside a Responses request,
    as a hosted call for the transcript and the conversation (see
    _claude_server_call): the search (action), the sources it read when
    the provider lists them, a code run's code and output head."""
    kind = item.get('type')
    if kind == 'code_interpreter_call':
        logs = '\n'.join(o.get('logs') or '' for o in item.get('outputs') or [] if isinstance(o, dict))
        args, output = {'code': (item.get('code') or '')[:HOSTED_RESULT_CHARS]}, logs.strip() or 'done'
    else:
        action = item.get('action') if isinstance(item.get('action'), dict) else {}
        args = {k: v for k, v in action.items() if k != 'sources'} or {'query': item.get('query') or ''}
        sources = [s.get('url') for s in action.get('sources') or [] if isinstance(s, dict) and s.get('url')]
        output = SEARCH_RECORD_NOTE.replace('titles and links', 'links') + '\n'.join(sources) if sources else \
            'The results were read in full when this search ran; they are not kept here.'
    failed = item.get('status') == 'failed'
    return {'type': 'mcp_call', 'id': item.get('id') or f'call_{uuid.uuid4().hex[:24]}',
            'name': {'code_interpreter_call': 'code_interpreter', 'x_search_call': 'x_search'}.get(kind, 'web_search'),
            'arguments': json.dumps(args, ensure_ascii=False),
            'output': '' if failed else output[:HOSTED_RESULT_CHARS],
            'error': 'failed' if failed else None, 'status': item.get('status') or 'completed'}


async def _responses_events(http, url, headers, payload, max_searches, who, sandbox=False):
    """Stream one Responses-API request (xAI's or OpenAI's — the same
    events) as LlmEngine events. Raises _Refused on an HTTP error and
    SearchLimit once the provider's own search loop passes `max_searches`
    (0 = no limit). With `sandbox` (OpenAI's code interpreter) it also
    yields ('_container', id) for the container the code ran in, and
    ('file', 'container_id/file_id') for each file the reply cites from it
    (container_file_citation annotations - how OpenAI hands back files
    the code made)."""
    searches = 0
    wrote = after_tool = False
    cited = set()
    async with http.stream('POST', url, json=payload, headers=headers) as resp:
        if resp.status_code >= 400:
            body = (await resp.aread()).decode('utf-8', 'replace')
            raise _Refused(f'{who} {resp.status_code}: {body[:400]}', body)
        async for ev in _sse_events(resp.aiter_lines()):
            etype = ev.get('type') or ''
            if etype == 'response.output_text.delta':
                if ev.get('delta'):
                    # Text before and after a search streams into the
                    # same message with nothing between ("…for
                    # you.Wait,…", observed 2026-09-30): break the line.
                    if wrote and after_tool:
                        yield ('text', '\n')
                    wrote, after_tool = True, False
                    yield ('text', ev['delta'])
            elif etype == 'response.output_item.added':
                if (ev.get('item') or {}).get('type') in _SEARCH_ITEM_TYPES:
                    searches += 1
                    if max_searches and searches > max_searches:
                        raise SearchLimit(f'more than {max_searches} web/X searches in one reply')
            elif etype == 'response.output_item.done':
                item = ev.get('item') or {}
                after_tool = item.get('type') != 'message'
                if item.get('type') == 'function_call':
                    yield ('tool_call', item.get('call_id'), item.get('name'),
                           item.get('arguments') or '{}')
                elif item.get('type') == 'mcp_call':
                    yield ('hosted_call', item)
                elif item.get('type') in ('web_search_call', 'x_search_call', 'code_interpreter_call'):
                    yield ('hosted_call', _responses_server_call(item))
                    if sandbox and item.get('type') == 'code_interpreter_call' and item.get('container_id'):
                        yield ('_container', item['container_id'])
                elif sandbox and item.get('type') == 'message':
                    for part in item.get('content') or []:
                        for note in (part.get('annotations') or []) if isinstance(part, dict) else []:
                            ref = f"{note.get('container_id')}/{note.get('file_id')}"
                            if note.get('type') == 'container_file_citation' and note.get('file_id') \
                                    and ref not in cited:
                                cited.add(ref)
                                yield ('file', ref)
            elif etype in ('response.completed', 'response.incomplete'):
                usage = (ev.get('response') or {}).get('usage') or {}
                yield ('usage', usage)
            elif etype in ('response.failed', 'error'):
                err = (ev.get('response') or {}).get('error') or ev.get('error') or ev
                raise LlmError(f"{who}: {err.get('message') if isinstance(err, dict) else err}")


class XaiLlm(LlmEngine):
    """Grok over the Responses API, streamed. Keeps everything a realtime
    call has: web and X search and MCP servers run at xAI, and the same
    search watchdog as text chat stops a runaway search loop."""
    id = 'xai'
    label = 'xAI Grok'
    description = 'Grok text models through the Responses API. Uses your xAI key.'
    hosted_tools = ('web_search', 'x_search', 'mcp')
    uses_xai_key = True
    # grok-4.20-non-reasoning, not grok-4.3: on a companion's voice prompt
    # (2026-09-30, three prompts each) grok-4.3 wrote avatar tool calls into
    # its speech ("[play_gesture: spin]") in 1 of 3 replies and narrated
    # instead of calling in others; 4.20 made real calls in 3 of 3 and
    # answered sooner (1.7-2.4 s vs 1.9-3.0 s to first output, ~31k-token
    # prompt, cached).
    fields = (
        Field('model', 'Model', 'text', 'grok-4.20-non-reasoning', placeholder='grok-4.20-non-reasoning'),
        Field('reasoning_effort', 'Reasoning', 'select', '',
              options=(('', "Model's default"), ('none', 'None - fastest reply'), ('low', 'Low'),
                       ('medium', 'Medium'), ('high', 'High')),
              help='Thinking before speaking, for models that offer it. grok-4.3 needs None: it '
                   'answers in about 0.8 s without it and about 4.5 s on its default, low '
                   '(Artificial Analysis, time to first answer token).'),
        # The word limits are Settings' own defaults; the size is the call
        # budget's (summary_threshold_tokens), here measured as a request.
        *conversation_fields(64000, 4000, 12000),
    )

    def __init__(self, settings, config):
        super().__init__(settings, config)
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10))
        self._no_reasoning = False

    async def stream(self, *, instructions, items, tools, conversation_key):
        max_searches = self.config['text_max_searches'] or 0
        payload = {
            'model': self.get('model') or 'grok-4.20-non-reasoning',
            'instructions': instructions,
            'input': _responses_input(items, tool_names={t.get('name') for t in tools or []
                                                         if t.get('type') == 'function'}),
            'stream': True,
            'store': False,
            'prompt_cache_key': conversation_key,
        }
        effort = self.get('reasoning_effort')
        # 'none' is sent, not omitted: grok-4.3's default effort is low.
        # Models without the setting refuse any value (grok-4.20-non-
        # reasoning: "does not support parameter reasoningEffort"), so a
        # refusal drops it for the rest of the call.
        if effort and not self._no_reasoning:
            payload['reasoning'] = {'effort': effort}
        if tools:
            payload['tools'] = tools
            if self.config['xai_max_turns']:
                payload['max_turns'] = int(self.config['xai_max_turns'])
        headers = {'Authorization': f"Bearer {self.config['xai_api_key']}"}
        try:
            async for ev in _responses_events(self._http, self.config['xai_responses_url'], headers,
                                              payload, max_searches, 'xAI'):
                yield ev
        except _Refused as e:
            # Refused before anything streamed: safe to ask again.
            if 'reasoning' in payload and 'reasoningeffort' in e.body.lower():
                self._no_reasoning = True
                async for ev in self.stream(instructions=instructions, items=items, tools=tools,
                                            conversation_key=conversation_key):
                    yield ev
                return
            raise

    async def close(self):
        await self._http.aclose()


# Files OpenAI's Responses API reads from an input_file, besides PDFs: text
# is extracted from documents and slides, spreadsheets get their own pass
# (OpenAI's file inputs guide; developer forum thread "Responses API now has
# expanded file input types: docx, pptx, csv, xlsx"). Plain text files
# (.csv included) go as text to every brain instead
# (session_service.attachment_part).
OPENAI_FILE_TYPES = frozenset((
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',     # .docx
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',   # .pptx
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',           # .xlsx
))

# Files OpenAI's code interpreter takes (its guide's "Supported files"
# table, 2026-10-02) - the ones a companion's attachments can reach it as,
# when the model can't read them directly.
OPENAI_SANDBOX_EXTS = frozenset((
    '.c', '.cs', '.cpp', '.csv', '.doc', '.docx', '.html', '.java', '.json', '.md', '.pdf', '.php', '.pptx',
    '.py', '.rb', '.tex', '.txt', '.css', '.js', '.sh', '.ts', '.jpeg', '.jpg', '.gif', '.pkl', '.png', '.tar',
    '.xlsx', '.xml', '.zip'))
# A code interpreter container expires after 20 unused minutes (same
# guide); one idle longer than this isn't reused.
OPENAI_CONTAINER_IDLE_S = 19 * 60
# The container each conversation last ran code in (conversation_key ->
# (container id, file ids it was given, last used, time.monotonic())).
_OPENAI_CONTAINERS = {}
# Models that refused the setup's reasoning effort; they run on their own
# default instead.
_OPENAI_NO_EFFORT = set()
# (server, model) pairs whose thinking mode wants its earlier reasoning sent
# back with tools: DeepSeek's thinking mode (on by default) answers a
# request that carries tools but not every earlier turn's reasoning_content
# with a 400 (api-docs.deepseek.com → Thinking Mode → Tool Calls,
# 2026-10-02). Conversations are rebuilt from the saved messages, which
# keep no reasoning, so such a model runs with thinking off
# (reasoning_effort 'none', its documented switch) once it has refused.
_NO_THINKING_WITH_TOOLS = set()
_REASONING_BACK_RE = re.compile(r'reasoning_content', re.IGNORECASE)

# The tools field both chat engines share.
TOOLS_FIELD = Field('tools', 'Tools', 'select', 'all',
                    options=(('all', 'All of the companion\'s tools'), ('none', 'No tools - talk only')),
                    help='Every tool description is read on every turn. Small local models '
                         'answer faster, and stay in character better, without them.')


def _openai_responses_tools(tools, hosted, container=None):
    """The app's tools (xAI Responses shapes) as OpenAI's Responses API
    takes them. Function tools say strict: false - the app's schemas are
    plain JSON Schema, not strict-mode ones. Code interpreter needs a
    container (`container`: an id to reuse, or {'type': 'auto', 'file_ids':
    [...]} for a new one; default a new empty one); an MCP server is run
    without asking for approval each call
    (OpenAI's default is to stop the reply and ask), and its key goes in
    the Authorization header the app's entry already formats as 'Bearer …'
    (OpenAI's `authorization` field takes a bare OAuth token)."""
    out = []
    for t in tools or []:
        kind = t.get('type')
        if kind == 'function':
            out.append({'type': 'function', 'name': t['name'], 'description': t.get('description') or '',
                        'parameters': t.get('parameters') or {'type': 'object', 'properties': {}},
                        'strict': False})
        elif kind not in hosted:
            continue
        elif kind == 'code_interpreter':
            out.append({'type': 'code_interpreter', 'container': container or {'type': 'auto'}})
        elif kind == 'mcp':
            entry = {k: v for k, v in t.items() if k != 'authorization'}
            entry['require_approval'] = 'never'
            if t.get('authorization'):
                entry['headers'] = {'Authorization': t['authorization'], **(t.get('headers') or {})}
            out.append(entry)
        else:
            out.append(dict(t))
    return out


class OpenAiLlm(LlmEngine):
    """Any OpenAI-compatible /chat/completions server, streamed with tool
    calls: Ollama, LM Studio, llama.cpp's llama-server (--jinja), vLLM,
    OpenRouter, Groq. On OpenAI's own API it speaks the Responses API
    instead (setting 'api'), which runs web search, code interpreter and
    remote MCP servers at OpenAI; other servers get function tools only."""
    id = 'openai'
    label = 'OpenAI-compatible'
    description = ('Local models (Ollama, LM Studio, llama.cpp, vLLM), OpenAI, or any hosted API '
                   'that speaks /v1/chat/completions.')
    fields = (
        OPENAI_URL,
        API_KEY,
        SERVES['llm'],
        Field('model', 'Model', 'text', '', placeholder='qwen3:8b'),
        Field('quick_model', 'Quick model', 'text', '',
              help='For quick looks: analyze_screen reading your screen or camera, and delegate_task\'s '
                   'quick checks - a smaller, faster model on the same server. Empty = the main model.'),
        Field('api', 'API', 'select', 'auto',
              options=(('auto', 'Automatic - Responses on OpenAI, Chat Completions elsewhere'),
                       ('chat', 'Chat Completions (/chat/completions)'),
                       ('responses', 'Responses (/responses)')),
              help='OpenAI\'s Responses API runs web search, code interpreter and remote MCP '
                   'servers for the companion, and reads attached PDFs and Office documents. Those '
                   'work only on OpenAI\'s own API (api.openai.com); another server on Responses '
                   'gets the app\'s own tools only.'),
        Field('reasoning_effort', 'Reasoning', 'select', '',
              options=(('', "Model's default"), ('none', 'None - fastest reply'), ('minimal', 'Minimal'),
                       ('low', 'Low'), ('medium', 'Medium'), ('high', 'High')),
              help='Thinking before answering, for reasoning models (OpenAI\'s gpt-5 family and '
                   'others). Not sent when left on the default; which values a model takes '
                   'varies.'),
        # Sized for a model loaded at 32k context: a 24k request leaves room
        # for the reply and the next turn, and summaries of ~2k/4k tokens
        # (1,500/3,000 words) don't crowd out the conversation.
        *conversation_fields(24000, 1500, 3000),
        Field('vision', 'Can see images', 'bool', False,
              help='Turn on for a vision model (e.g. Qwen3.5, Gemma 4, a "VL" build with its '
                   'projector loaded). Images you attach in chat reach it, and analyze_screen '
                   'runs on it instead of Grok vision.'),
        TOOLS_FIELD,
        Field('extra_body', 'Extra request fields (JSON)', 'json', '',
              placeholder='{"options": {"num_ctx": 16384}}',
              help='Merged into every request, for server-specific options, e.g. '
                   '{"options": {"num_ctx": 16384}} for Ollama.'),
    )

    @staticmethod
    def _official(settings):
        return (urlparse(settings.get('base_url') or '').hostname or '') == 'api.openai.com'

    @classmethod
    def _responses(cls, settings):
        api = settings.get('api') or 'auto'
        return api == 'responses' or (api == 'auto' and cls._official(settings))

    @classmethod
    def hosted_for(cls, settings):
        # Searches, code and MCP run on OpenAI's own API only: a local
        # server that answers /responses (LM Studio, Ollama) has none.
        if cls._responses(settings) and cls._official(settings):
            return ('web_search', 'code_interpreter', 'mcp')
        return ()

    @classmethod
    def file_types(cls, settings):
        return OPENAI_FILE_TYPES if cls._responses(settings) and cls._official(settings) else frozenset()

    @classmethod
    def sandbox_accepts(cls, settings, filename):
        return (cls._responses(settings) and cls._official(settings)
                and ('.' + filename.rsplit('.', 1)[-1].lower() if '.' in filename else '') in OPENAI_SANDBOX_EXTS)

    @classmethod
    def download_file(cls, settings, file_id):
        """A file the code interpreter made: 'container_id/file_id' (as
        _responses_events reports it), from OpenAI's container files API."""
        container_id, cfile = file_id.split('/', 1)
        base = settings.get('base_url').rstrip('/') + f'/containers/{container_id}/files/{cfile}'
        headers = {'Authorization': f"Bearer {settings.get('api_key')}"}
        timeout = httpx.Timeout(300, connect=10)
        meta = httpx.get(base, headers=headers, timeout=timeout)
        data = httpx.get(base + '/content', headers=headers, timeout=timeout)
        for resp in (meta, data):
            if resp.status_code >= 400:
                raise LlmError(f'OpenAI file download {resp.status_code}: {resp.text[:300]}')
        name = (meta.json().get('path') or cfile).rsplit('/', 1)[-1]
        return name, data.content, mimetypes.guess_type(name)[0] or 'application/octet-stream'

    @classmethod
    def upload_file(cls, settings, *, filename, data, mimetype, expires_seconds):
        """OpenAI's Files API, purpose user_data (files for model input),
        expiring by OpenAI's own clock: it takes 1 hour to 30 days."""
        if not (cls._responses(settings) and cls._official(settings)):
            return None
        form = {'purpose': 'user_data'}
        if expires_seconds:
            form['expires_after[anchor]'] = 'created_at'
            form['expires_after[seconds]'] = str(min(max(int(expires_seconds), 3600), 2592000))
        resp = httpx.post(settings.get('base_url').rstrip('/') + '/files',
                          headers={'Authorization': f"Bearer {settings.get('api_key')}"},
                          data=form, files={'file': (filename, data, mimetype)},
                          timeout=httpx.Timeout(300, connect=10))
        if resp.status_code >= 400:
            raise LlmError(f'OpenAI file upload {resp.status_code}: {resp.text[:300]}')
        body = resp.json()
        expires = body.get('expires_at')
        return body['id'], (datetime.fromtimestamp(int(expires), timezone.utc).replace(tzinfo=None)
                            .isoformat(timespec='seconds') if expires else None)

    def __init__(self, settings, config):
        super().__init__(settings, config)
        headers = {'Authorization': f"Bearer {self.get('api_key')}"} if self.get('api_key') else {}
        self._http = httpx.AsyncClient(headers=headers, timeout=httpx.Timeout(300, connect=10))
        self._no_tools = False

    @staticmethod
    def messages(instructions, items, vision=False):
        """Chat messages from realtime items. Local chat templates are strict
        where the hosted APIs are lenient: only the first message may be a
        system message (later notes become user lines), roles must
        alternate (consecutive user lines are joined), and each tool result
        must follow the assistant message that made the call. With `vision`
        a user message's input_image parts go along as image_url parts."""
        answered = _answered_calls(items)
        msgs = [{'role': 'system', 'content': instructions}]
        outputs = {it.get('call_id'): it for it in items
                   if it.get('type') == 'function_call_output' and it.get('call_id') in answered}

        def add_user(text, images=()):
            parts = ([{'type': 'text', 'text': text}] if text else []) + [
                {'type': 'image_url', 'image_url': {'url': url}} for url in images]
            last = msgs[-1]
            if last['role'] != 'user':
                msgs.append({'role': 'user', 'content': text if not images else parts})
            elif isinstance(last['content'], str) and not images:
                last['content'] += '\n\n' + text
            else:
                head = last['content'] if isinstance(last['content'], list) else [
                    {'type': 'text', 'text': last['content']}]
                last['content'] = head + parts

        for it in items:
            kind = _kind(it)
            if kind == 'message':
                text = item_text(it)
                role = it.get('role')
                images = [p.get('image_url') for p in it.get('content') or []
                          if vision and role == 'user' and isinstance(p, dict)
                          and p.get('type') == 'input_image' and p.get('image_url')]
                if not text and not images:
                    continue
                if role == 'assistant':
                    msgs.append({'role': 'assistant', 'content': text})
                else:
                    add_user(text if role == 'user' else f'[System note] {text}', images)
            elif kind == 'function_call':
                if it.get('call_id') not in answered:
                    add_user(f'[System note] {_note_for(it)}')
                    continue
                call = {'id': it['call_id'], 'type': 'function',
                        'function': {'name': it.get('name') or '', 'arguments': it.get('arguments') or '{}'}}
                # The call joins the assistant turn it belongs to: the reply
                # just spoken, or — for parallel calls — the turn whose
                # results were just placed. Its result goes right after.
                owner = next((m for m in reversed(msgs) if m['role'] != 'tool'), None)
                if owner is not None and owner['role'] == 'assistant':
                    owner.setdefault('tool_calls', []).append(call)
                else:
                    msgs.append({'role': 'assistant', 'content': None, 'tool_calls': [call]})
                msgs.append({'role': 'tool', 'tool_call_id': it['call_id'],
                             'content': outputs[it['call_id']].get('output') or ''})
            elif kind == 'function_call_output' and it.get('call_id') not in answered:
                add_user(f'[System note] {_note_for(it)}')
        return msgs

    async def _stream_responses(self, *, instructions, items, tools, conversation_key):
        """One reply over the Responses API (OpenAI's own, or a server that
        offers it). Stateless like the chat path: the whole conversation
        every time, nothing stored at OpenAI; prompt_cache_key keeps a
        companion's requests on the same cache."""
        max_searches = self.config['text_max_searches'] or 0
        payload = {
            'model': self.get('model'),
            'instructions': instructions,
            'input': _responses_input(items, vision=bool(self.get('vision')),
                                      tool_names=set() if self.get('tools') == 'none' else
                                      {t.get('name') for t in tools or [] if t.get('type') == 'function'}),
            'stream': True,
            'store': False,
            'prompt_cache_key': conversation_key,
            **json_field(self, 'extra_body'),
        }
        if self.get('reasoning_effort') and self.get('model') not in _OPENAI_NO_EFFORT:
            payload['reasoning'] = {'effort': self.get('reasoning_effort')}
        # Files for the code interpreter (attachment parts marked 'sandbox',
        # see session_service.attachment_part) go in its container, not the
        # input. The container this conversation last ran in is reused while
        # it lives and already holds them; otherwise a new one gets them all.
        sandbox_ids = list(dict.fromkeys(
            p['file_id'] for it in items if _kind(it) == 'message' and it.get('role') == 'user'
            for p in _media_parts(it) if p.get('sandbox') and p.get('file_id')))
        reuse = _OPENAI_CONTAINERS.get(conversation_key)
        if reuse and (time.monotonic() - reuse[2] > OPENAI_CONTAINER_IDLE_S or not set(sandbox_ids) <= reuse[1]):
            reuse = None
        container = reuse[0] if reuse else {'type': 'auto', 'file_ids': sandbox_ids}
        converted = (_openai_responses_tools(tools, self.hosted_tools, container)
                     if self.get('tools') != 'none' else [])
        code = any(t['type'] == 'code_interpreter' for t in converted)
        # What the searches read and the code printed, for the record of
        # each (_responses_server_call); OpenAI leaves them out unless asked.
        include = (['web_search_call.action.sources'] if any(t['type'] == 'web_search' for t in converted) else []) \
            + (['code_interpreter_call.outputs'] if code else [])
        if include and self._official(self.settings):
            payload['include'] = include
        if converted:
            payload['tools'] = converted
            if max_searches and not code and any(t['type'] != 'function' for t in converted):
                # OpenAI's own cap on built-in tool calls in one reply (the
                # model must answer once it is reached), at the search
                # limit; the stream watchdog stays as the backstop. Not
                # with code interpreter: it counts every code run too.
                payload['max_tool_calls'] = int(max_searches)
        url = self.get('base_url').rstrip('/') + '/responses'
        try:
            async for ev in _responses_events(self._http, url, None, payload, max_searches, 'OpenAI', sandbox=code):
                if ev[0] == '_container':
                    _OPENAI_CONTAINERS[conversation_key] = (ev[1], frozenset(sandbox_ids), time.monotonic())
                else:
                    yield ev
        except _Refused as e:
            if 'reasoning' in payload and 'reasoning' in e.body.lower():
                # A model without this effort level (gpt-6.1-sol takes no
                # 'none'): its own default from now on, remembered per model.
                _logger.warning('%s refuses reasoning effort %r - using its default',
                                self.get('model'), self.get('reasoning_effort'))
                _OPENAI_NO_EFFORT.add(self.get('model'))
            elif reuse and 'container' in e.body.lower():
                # The container expired (20 idle minutes) before we noticed:
                # once more in a new one.
                _OPENAI_CONTAINERS.pop(conversation_key, None)
            else:
                raise
            async for ev in self._stream_responses(instructions=instructions, items=items, tools=tools,
                                                   conversation_key=conversation_key):
                yield ev

    async def stream(self, *, instructions, items, tools, conversation_key):
        if self._responses(self.settings):
            async for ev in self._stream_responses(instructions=instructions, items=items, tools=tools,
                                                   conversation_key=conversation_key):
                yield ev
            return
        payload = {
            'model': self.get('model'),
            'messages': self.messages(instructions, items, vision=bool(self.get('vision'))),
            'stream': True,
            'stream_options': {'include_usage': True},
            **json_field(self, 'extra_body'),
        }
        if self.get('reasoning_effort'):
            payload['reasoning_effort'] = self.get('reasoning_effort')
        thinking_key = (self.get('base_url'), self.get('model'))
        if thinking_key in _NO_THINKING_WITH_TOOLS:
            payload['reasoning_effort'] = 'none'
        functions = [t for t in tools or [] if t.get('type') == 'function']
        if functions and self.get('tools') != 'none' and not self._no_tools:
            payload['tools'] = [{'type': 'function', 'function': {
                'name': t['name'], 'description': t.get('description') or '',
                'parameters': t.get('parameters') or {'type': 'object', 'properties': {}}}}
                for t in functions]
        url = self.get('base_url').rstrip('/') + '/chat/completions'
        calls, by_index = [], {}   # [{id, name, arguments}] in order; stream index → call
        reported, written = False, 0
        async with self._http.stream('POST', url, json=payload) as resp:
            if resp.status_code >= 400:
                body = (await resp.aread()).decode('utf-8', 'replace')
                if 'tools' in payload and _NO_TOOLS_RE.search(body):
                    # A model that can't call tools: talk without them for
                    # the rest of the engine's life (one call, one chat turn).
                    _logger.warning('%s takes no tools - answering without them: %s',
                                    self.get('model'), body[:200])
                    self._no_tools = True
                    async for ev in self.stream(instructions=instructions, items=items, tools=tools,
                                                conversation_key=conversation_key):
                        yield ev
                    return
                if ('tools' in payload and resp.status_code == 400 and _REASONING_BACK_RE.search(body)
                        and thinking_key not in _NO_THINKING_WITH_TOOLS):
                    _logger.warning('%s wants its reasoning sent back with tools - running with thinking '
                                    'off: %s', self.get('model'), body[:200])
                    _NO_THINKING_WITH_TOOLS.add(thinking_key)
                    async for ev in self.stream(instructions=instructions, items=items, tools=tools,
                                                conversation_key=conversation_key):
                        yield ev
                    return
                raise LlmError(f'{resp.status_code}: {body[:400]}')
            async for ev in _sse_events(resp.aiter_lines()):
                if ev.get('error'):
                    err = ev['error']
                    raise LlmError(err.get('message') if isinstance(err, dict) else str(err))
                for choice in ev.get('choices') or []:
                    delta = choice.get('delta') or {}
                    if delta.get('content'):
                        written += len(delta['content'].encode('utf-8'))
                        yield ('text', delta['content'])
                    for tc in delta.get('tool_calls') or []:
                        # Parallel calls are told apart by index; servers
                        # that omit it (or reuse one) start each call with
                        # a new id.
                        index = tc.get('index')
                        slot = by_index.get(index) if index is not None else (calls[-1] if calls else None)
                        if slot is None or (tc.get('id') and slot['id'] and tc['id'] != slot['id']):
                            slot = {'id': None, 'name': '', 'arguments': ''}
                            calls.append(slot)
                            if index is not None:
                                by_index[index] = slot
                        slot['id'] = tc.get('id') or slot['id']
                        fn = tc.get('function') or {}
                        name = fn.get('name') or ''
                        if name != slot['name']:   # some servers repeat the whole name in every chunk
                            slot['name'] += name
                        slot['arguments'] += fn.get('arguments') or ''
                if ev.get('usage'):
                    u = ev['usage']
                    reported = True
                    yield ('usage', {
                        'input_tokens': u.get('prompt_tokens') or 0,
                        'output_tokens': u.get('completion_tokens') or 0,
                        'input_tokens_details': {'cached_tokens': (u.get('prompt_tokens_details') or {})
                                                 .get('cached_tokens') or 0},
                    })
        if not reported:
            # A server that reports no usage still needs measuring: request
            # sizes decide when a conversation is summarised
            # (setups.context_full). Estimated from UTF-8 size at 3.5 bytes
            # a token - a little high for English (about 4), which errs
            # towards summarising early, and near right for Japanese.
            sent = len(json.dumps(payload['messages'], ensure_ascii=False).encode('utf-8')) \
                + len(json.dumps(payload.get('tools') or [], ensure_ascii=False).encode('utf-8'))
            written += sum(len((c['name'] + c['arguments']).encode('utf-8')) for c in calls)
            yield ('usage', {'input_tokens': round(sent / 3.5), 'output_tokens': round(written / 3.5),
                             'input_tokens_details': {'cached_tokens': 0}, 'estimated': True})
        for slot in calls:
            if slot['name']:
                # A server that sends no id gets a unique one: call ids pair
                # each result with its call across the whole conversation.
                yield ('tool_call', slot['id'] or f'call_{uuid.uuid4().hex[:24]}', slot['name'],
                       slot['arguments'] or '{}')

    async def close(self):
        await self._http.aclose()


class OpenAiCloudLlm(OpenAiLlm):
    """OpenAI's own API as a brain: always the Responses API, with web
    search, code interpreter and remote MCP servers at OpenAI, its Files
    API and prompt caching, and OpenAI's current models as defaults
    (developers.openai.com models page, 2026-10-02)."""
    id = 'openai_cloud'
    label = 'OpenAI'
    description = ('OpenAI\'s models through the Responses API, with web search, code interpreter, '
                   'remote MCP servers and prompt caching.')
    hosted_tools = ('web_search', 'code_interpreter', 'mcp')
    fields = (
        OPENAI_CLOUD_URL,
        OPENAI_CLOUD_KEY,
        # gpt-6.1-sol: "near-Astra performance at a lower cost" - $2/$10
        # per M, cached input $0.10; 1M context, sees images.
        Field('model', 'Model', 'text', 'gpt-6.1-sol', placeholder='gpt-6.1-sol',
              help='gpt-6.1-sol (balanced), gpt-6-astra (most capable, 5x the price) or gpt-6-luna '
                   '(fastest and cheapest).'),
        # gpt-6-luna: OpenAI's fastest current model ($0.10/$0.50 per M),
        # and the only one of the three that takes reasoning 'none'.
        Field('quick_model', 'Quick model', 'text', 'gpt-6-luna', placeholder='gpt-6-luna',
              help='For quick looks: analyze_screen reading your screen or camera, and delegate_task\'s '
                   'quick checks. Empty = the main model.'),
        Field('reasoning_effort', 'Reasoning', 'select', 'low',
              options=(('', "Model's default"), ('none', 'None - fastest (gpt-6-luna)'), ('low', 'Low'),
                       ('medium', 'Medium'), ('high', 'High'), ('xhigh', 'Extra high'), ('max', 'Max')),
              help='Thinking before answering. Low suits conversation; gpt-6.1-sol and gpt-6-astra start at '
                   'Low (a level a model doesn\'t take falls back to its default).'),
        # As Claude's: 1M context isn't the limit, the cost of resending a
        # growing conversation is - cached input is 5-10% of the price.
        *conversation_fields(128000, 4000, 12000),
        Field('vision', 'Can see images', 'bool', True,
              help='OpenAI\'s current models all see images: ones you attach in chat reach it, and '
                   'analyze_screen runs on it instead of Grok vision.'),
        TOOLS_FIELD,
        Field('extra_body', 'Extra request fields (JSON)', 'json', '',
              placeholder='{"service_tier": "priority"}',
              help='Merged into every request, for Responses API options the app doesn\'t set.'),
    )

    @classmethod
    def _responses(cls, settings):
        return True


def _claude_version(model):
    """('opus', (5, 5)) for claude-opus-5-5, ('opus', (5, 0)) for
    claude-opus-5, ('haiku', (4, 5)) for claude-haiku-4-5-20251001 - a date
    suffix is never the minor version. ('', (0, 0)) for anything else."""
    m = re.match(r'claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)', model or '')
    return (m.group(1), (int(m.group(2)), int(m.group(3) or 0))) if m else ('', (0, 0))


def _takes_fallbacks(model):
    """Models that take server-side refusal fallbacks (`fallbacks:
    "default"`, beta server-side-fallback-2026-07-01) on the Claude API: a
    reply a safety classifier declines is finished by the model Anthropic
    recommends for that category, on the same stream."""
    family, version = _claude_version(model)
    return ((family == 'opus' and version >= (5, 0)) or (family == 'sonnet' and version >= (5, 5))
            or (family == 'fable' and version >= (5, 1)))


# Request options a model refused (a 400 naming them), per model, so later
# requests skip them: Haiku 4.5 takes no effort, for one.
_CLAUDE_REFUSED = {}
# The code-execution container each conversation last ran in
# (conversation_key -> (container id, expires_at)): files Claude made or
# unpacked stay there between requests until Anthropic expires it.
_CLAUDE_CONTAINERS = {}


def _data_url(url):
    """(media type, base64 data) of a data: URL, else None."""
    m = re.match(r'^data:([^;,]+);base64,(.*)$', url or '', re.DOTALL)
    return (m.group(1), m.group(2)) if m else None


def _claude_media(part, sandbox=False):
    """An input_image / input_file part as a Claude image or document
    block - or, for a file only the code sandbox opens (part 'sandbox'),
    a container_upload when the request has the sandbox (`sandbox`) - or
    None when it can't be sent."""
    if part.get('sandbox'):
        return {'type': 'container_upload', 'file_id': part['file_id']} if sandbox and part.get('file_id') else None
    if part.get('file_id'):   # uploaded to Anthropic's Files API
        return {'type': 'image' if part['type'] == 'input_image' else 'document',
                'source': {'type': 'file', 'file_id': part['file_id']}}
    if part['type'] == 'input_image':
        inline = _data_url(part['image_url'])
        if inline:
            return {'type': 'image', 'source': {'type': 'base64', 'media_type': inline[0], 'data': inline[1]}}
        if part['image_url'].startswith(('http://', 'https://')):
            return {'type': 'image', 'source': {'type': 'url', 'url': part['image_url']}}
        return None
    inline = _data_url(part.get('file_data'))
    if inline and inline[0] == 'application/pdf':
        return {'type': 'document', 'source': {'type': 'base64', 'media_type': inline[0], 'data': inline[1]},
                'title': part.get('filename') or 'document'}
    return None


def _claude_id(call_id):
    # Claude's tool_use ids are [A-Za-z0-9_-]+; other engines' ids may not be.
    return re.sub(r'[^A-Za-z0-9_-]', '_', str(call_id or 'call'))


def _claude_messages(items, vision=False, tool_names=(), sandbox=False):
    """Claude messages from realtime items. A tool call joins the assistant
    turn that made it and its result opens the next user turn (results
    first, as the API requires); parallel calls share those two turns.
    Only calls of a tool this request declares (`tool_names`) go as
    tool_use blocks - the API refuses tool_use without its definition (a
    text leg's last, toolless request; an MCP call the provider ran) - the
    rest as notes. Files for the code sandbox go as container_upload only
    when the request has it (`sandbox`). Later system notes become user
    lines, like the chat engine's. No thinking blocks are replayed: the
    conversation is rebuilt
    from the app's rows each request, and a block replayed into an edited
    history is refused (preserved thinking); leaving all of them out is
    allowed."""
    answered = _answered_calls(items) & {it.get('call_id') for it in items
                                         if it.get('type') == 'function_call' and it.get('name') in tool_names}
    outputs = {it.get('call_id'): it for it in items
               if it.get('type') == 'function_call_output' and it.get('call_id') in answered}
    msgs = []

    def add(role, blocks):
        if msgs and msgs[-1]['role'] == role:
            msgs[-1]['content'].extend(blocks)
        else:
            msgs.append({'role': role, 'content': list(blocks)})

    for it in items:
        kind = _kind(it)
        if kind == 'message':
            role = it.get('role')
            text = item_text(it)
            if role == 'assistant':
                if text:
                    add('assistant', [{'type': 'text', 'text': text}])
                continue
            blocks = [b for b in (_claude_media(p, sandbox) for p in _media_parts(it)
                                  if vision or p.get('sandbox')) if b] if role == 'user' else []
            if text:
                blocks.append({'type': 'text', 'text': text if role == 'user' else f'[System note] {text}'})
            if blocks:
                add('user', blocks)
        elif kind == 'function_call':
            if it.get('call_id') not in answered:
                add('user', [{'type': 'text', 'text': f'[System note] {_note_for(it)}'}])
                continue
            try:
                args = json.loads(it.get('arguments') or '{}')
            except ValueError:
                args = {}
            use = {'type': 'tool_use', 'id': _claude_id(it['call_id']), 'name': it.get('name') or 'tool',
                   'input': args if isinstance(args, dict) else {}}
            result = {'type': 'tool_result', 'tool_use_id': use['id'],
                      'content': outputs[it['call_id']].get('output') or '(no output)'}
            last = msgs[-1] if msgs else None
            if (last and last['role'] == 'user' and len(msgs) > 1 and msgs[-2]['role'] == 'assistant'
                    and all(b['type'] == 'tool_result' for b in last['content'])):
                msgs[-2]['content'].append(use)   # another call of the same turn
                last['content'].append(result)
            else:
                add('assistant', [use])
                msgs.append({'role': 'user', 'content': [result]})
        elif kind == 'function_call_output' and it.get('call_id') not in answered:
            add('user', [{'type': 'text', 'text': f'[System note] {_note_for(it)}'}])
    # The conversation must open with the user and end with them: a call
    # the companion opened, or a reply asked for right after its own words
    # (no assistant prefill on current models).
    if not msgs or msgs[0]['role'] != 'user':
        msgs.insert(0, {'role': 'user', 'content': [{'type': 'text', 'text': '[System note] The conversation begins.'}]})
    if msgs[-1]['role'] != 'user':
        msgs.append({'role': 'user', 'content': [{'type': 'text', 'text': '[System note] Your turn again.'}]})
    return msgs


# A hosted call's recorded result is a reminder of what was done, not the
# content itself (the reply already says what it found): this many
# characters at most.
HOSTED_RESULT_CHARS = 1500
# Said at the head of a search or page-read record, so a later turn doesn't
# take titles and links for all the search returned: shown only those,
# Claude "corrected" a reply it had written from the pages' text
# (2026-10-02).
SEARCH_RECORD_NOTE = ('The results were read in full when this search ran; only their titles and links '
                      'are kept here.\n')
FETCH_RECORD_NOTE = 'The page was read in full when it was fetched; only its title and link are kept here.\n'


def _claude_server_call(use, result):
    """A web search, page fetch or code run Claude did inside its request,
    as a hosted call (an xAI-shaped mcp_call item) for the transcript and
    the conversation: later requests are rebuilt from those, and with no
    trace of a search Claude decides it never ran one (it 'corrected' a
    searched news summary as made up, 2026-10-02). Kept short: queries,
    page titles and links, a code run's output head."""
    content = result.content
    error = None
    if result.type == 'web_search_tool_result':
        if isinstance(content, list):
            output = SEARCH_RECORD_NOTE + '\n'.join(
                f'{getattr(r, "title", "") or ""} - {getattr(r, "url", "")}' for r in content)
        else:
            error = getattr(content, 'error_code', None) or 'failed'
    elif result.type == 'web_fetch_tool_result':
        if getattr(content, 'type', '') == 'web_fetch_result':
            title = getattr(getattr(content, 'content', None), 'title', None) or ''
            output = FETCH_RECORD_NOTE + f'{title} - {getattr(content, "url", "")}'.strip(' -')
        else:
            error = getattr(content, 'error_code', None) or 'failed'
    else:
        if getattr(content, 'type', '') == 'bash_code_execution_result':
            output = (content.stdout or '') + (f'\n[stderr] {content.stderr}' if content.stderr else '')
            output = output.strip() or f'(exit code {content.return_code})'
        else:
            error = getattr(content, 'error_code', None) or 'failed'
    return {'type': 'mcp_call', 'id': use.id, 'name': use.name,
            'arguments': json.dumps(use.input or {}, ensure_ascii=False),
            'output': '' if error else output[:HOSTED_RESULT_CHARS],
            'error': error, 'status': 'failed' if error else 'completed'}


def _claude_tools(tools, max_searches):
    """(tools, mcp_servers) for the Messages API from the app's tools.

    Web search brings web fetch along (reading a page a link in the
    conversation points to), each capped per request by max_uses (enforced
    by Anthropic). Both are the basic versions, which hand results straight
    to the model. The dynamic-filtering ones (web_*_20260209) run every
    search from code Claude writes in a sandbox: on Sal's calls
    (2026-10-02) that code failed on each first try, so every turn
    searched twice and took ~25 s; they would also be a second sandbox
    beside code execution, which confuses the model (Claude API skill).
    Code execution is Claude's sandbox: files the user attaches that
    Claude can't read directly are uploaded into it. An MCP server becomes
    an MCP connector server plus its toolset; its key travels bare."""
    out, servers = [], []
    kinds = {t.get('type') for t in tools or []}
    code = 'code_interpreter' in kinds
    names = set()
    for t in tools or []:
        kind = t.get('type')
        if kind == 'function':
            out.append({'name': t['name'], 'description': t.get('description') or '',
                        'input_schema': t.get('parameters') or {'type': 'object', 'properties': {}}})
        elif kind == 'web_search':
            for entry in ({'type': 'web_search_20250305', 'name': 'web_search'},
                          {'type': 'web_fetch_20250910', 'name': 'web_fetch'}):
                if max_searches:
                    entry['max_uses'] = int(max_searches)
                out.append(entry)
        elif kind == 'mcp' and t.get('server_url'):
            base = re.sub(r'[^A-Za-z0-9_-]', '_', t.get('server_label') or 'mcp')[:60] or 'mcp'
            name, n = base, 2
            while name in names:
                name, n = f'{base}_{n}', n + 1
            names.add(name)
            server = {'type': 'url', 'url': t['server_url'], 'name': name}
            token = re.sub(r'^Bearer\s+', '', t.get('authorization') or '')
            if token:
                server['authorization_token'] = token
            servers.append(server)
            toolset = {'type': 'mcp_toolset', 'mcp_server_name': name}
            if t.get('allowed_tools'):
                toolset['default_config'] = {'enabled': False}
                toolset['configs'] = {n: {'enabled': True} for n in t['allowed_tools']}
            out.append(toolset)
    if code:
        out.append({'type': 'code_execution_20260521', 'name': 'code_execution'})
    return out, servers


class AnthropicLlm(LlmEngine):
    """Claude over Anthropic's Messages API (the official SDK), streamed.
    The companion's prompt and tools are cached between requests, so a
    long prompt resent every turn is billed at the cache-read rate. Runs
    web search, code execution and remote MCP servers at Anthropic."""
    id = 'anthropic'
    label = 'Anthropic (Claude)'
    description = 'Claude models through Anthropic\'s Messages API, with prompt caching.'
    hosted_tools = ('web_search', 'code_interpreter', 'mcp')
    fields = (
        Field('base_url', 'Server URL', 'url', 'https://api.anthropic.com', scope='connection',
              placeholder='https://api.anthropic.com',
              help='Anthropic\'s API. Change it only for a proxy that speaks the Messages API.'),
        Field('api_key', 'API key', 'secret', '', scope='connection',
              help='A Claude API key, from platform.claude.com → API keys.'),
        Field('model', 'Model', 'text', 'claude-opus-5-5', placeholder='claude-opus-5-5',
              help='e.g. claude-opus-5-5, claude-sonnet-5-5, or claude-haiku-4-5 for the quickest '
                   'replies.'),
        # Haiku 4.5: Anthropic's fastest current model, and it sees images
        # (Claude API skill model table, 2026-09-25).
        Field('quick_model', 'Quick model', 'text', 'claude-haiku-4-5', placeholder='claude-haiku-4-5',
              help='For quick looks: analyze_screen reading your screen or camera, and delegate_task\'s '
                   'quick checks. Empty = the main model.'),
        Field('effort', 'Effort', 'select', 'low',
              options=(('', "Model's default"), ('low', 'Low - quickest replies'), ('medium', 'Medium'),
                       ('high', 'High'), ('xhigh', 'Extra high'), ('max', 'Max')),
              help='How much Claude thinks before answering, and how many tokens it spends. Low '
                   'suits conversation (Claude API guidance); current models think adaptively '
                   'within it. Skipped for a model without the setting (Haiku 4.5).'),
        # Claude's context (1M on current models) isn't the limit, the cost
        # of a growing conversation is. 128k, not Grok's 64k: the fixed
        # part (prompt, tools, summary) counts ~31k on Claude against ~18k
        # on Grok (Sal, 2026-10-02), and cache reads make the extra room
        # cheap (~$0.20/M on Opus/Sonnet 5.5) - Jonathan's pick. Word
        # limits are Settings' own.
        *conversation_fields(128000, 4000, 12000),
        Field('vision', 'Can see images and PDFs', 'bool', True,
              help='Images and PDFs you attach in chat reach Claude, and analyze_screen runs on it '
                   'instead of Grok vision.'),
        TOOLS_FIELD,
        Field('extra_body', 'Extra request fields (JSON)', 'json', '',
              placeholder='{"inference_geo": "us"}',
              help='Merged into every request, for Messages API options the app doesn\'t set.'),
    )

    @classmethod
    def file_types(cls, settings):
        return frozenset(('application/pdf',)) if settings.get('vision') else frozenset()

    @classmethod
    def sandbox_accepts(cls, settings, filename):
        return True

    @classmethod
    def upload_file(cls, settings, *, filename, data, mimetype, expires_seconds):
        """Anthropic's Files API (no longer beta); Anthropic deletes the
        file after expires_seconds, which it takes from 1 hour to 90 days
        (SDK docs)."""
        import anthropic
        if expires_seconds:
            expires_seconds = min(max(int(expires_seconds), 3600), 7776000)
        client = anthropic.Anthropic(api_key=settings.get('api_key') or None,
                                     base_url=settings.get('base_url') or None, timeout=300.0)
        try:
            meta = client.files.upload(file=(filename, data, mimetype),
                                       **({'expires_in_seconds': int(expires_seconds)} if expires_seconds else {}))
        except anthropic.APIError as e:
            raise LlmError(f'Claude file upload: {e}') from e
        finally:
            client.close()
        expires = (datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=int(expires_seconds))
                   ).isoformat(timespec='seconds') if expires_seconds else None
        return meta.id, expires

    @classmethod
    def download_file(cls, settings, file_id):
        """A file the code sandbox returned, from Anthropic's Files API."""
        import anthropic
        client = anthropic.Anthropic(api_key=settings.get('api_key') or None,
                                     base_url=settings.get('base_url') or None, timeout=300.0)
        try:
            meta = client.files.retrieve_metadata(file_id)
            data = client.files.download(file_id).read()
        except anthropic.APIError as e:
            raise LlmError(f'Claude file download: {e}') from e
        finally:
            client.close()
        return meta.filename or file_id, data, meta.mime_type or 'application/octet-stream'

    def __init__(self, settings, config):
        super().__init__(settings, config)
        import anthropic   # imported here: only a Claude connection needs it
        self._anthropic = anthropic
        self._client = anthropic.AsyncAnthropic(
            api_key=self.get('api_key') or None, base_url=self.get('base_url') or None,
            timeout=300.0)

    async def stream(self, *, instructions, items, tools, conversation_key):
        model = self.get('model') or 'claude-opus-5-5'
        refused = _CLAUDE_REFUSED.setdefault(model, set())
        max_searches = self.config['text_max_searches'] or 0
        claude_tools, servers = (_claude_tools(tools, max_searches)
                                 if self.get('tools') != 'none' else ([], []))
        sandbox = any(t.get('name') == 'code_execution' for t in claude_tools)
        messages = _claude_messages(items, vision=bool(self.get('vision')),
                                    tool_names={t['name'] for t in claude_tools if 'input_schema' in t},
                                    sandbox=sandbox)
        betas = []
        # The prompt never changes within a call or a chat (the clock rides
        # in the conversation), so it gets a cache marker of its own
        # (tools render before it and share it); the top-level marker
        # caches the conversation as it grows.
        extra = {'cache_control': {'type': 'ephemeral'}}
        if servers:
            extra['mcp_servers'] = servers
            betas.append('mcp-client-2025-11-20')
        if self.get('effort') and 'effort' not in refused:
            extra['output_config'] = {'effort': self.get('effort')}
        official = (urlparse(self.get('base_url') or '').hostname or '') == 'api.anthropic.com'
        if official and _takes_fallbacks(model) and 'fallbacks' not in refused:
            extra['fallbacks'] = 'default'
            betas.append('server-side-fallback-2026-07-01')
        container = _CLAUDE_CONTAINERS.get(conversation_key) if sandbox else None
        if container and (not container[1] or container[1] > datetime.now(timezone.utc) + timedelta(minutes=1)):
            # The sandbox this conversation last used: its files and
            # unpacked uploads are still there.
            extra['container'] = container[0]
        extra.update(json_field(self, 'extra_body'))
        params = {'model': model, 'max_tokens': 64000, 'messages': messages}
        if instructions:
            params['system'] = [{'type': 'text', 'text': instructions, 'cache_control': {'type': 'ephemeral'}}]
        if claude_tools:
            params['tools'] = claude_tools
        if betas:
            params['betas'] = betas

        wrote = after_tool = False
        hosted, mcp_uses, made = [], {}, []
        server_uses = {}   # server_tool_use id -> block (web search/fetch, code)
        sent = None        # usage of the request as sent (message_start)
        for _attempt in range(4):   # a reply paused mid server-tool loop resumes
            try:
                async with self._client.beta.messages.stream(**params, extra_body=extra) as stream:
                    async for ev in stream:
                        if ev.type == 'message_start' and sent is None:
                            sent = ev.message.usage
                        elif ev.type == 'content_block_start':
                            block_type = ev.content_block.type
                            if block_type == 'text':
                                if wrote and after_tool:
                                    yield ('text', '\n')   # text after a search: a new line
                            elif block_type not in ('thinking', 'redacted_thinking', 'fallback'):
                                after_tool = True
                        elif ev.type == 'content_block_delta' and ev.delta.type == 'text_delta':
                            if ev.delta.text:
                                wrote, after_tool = True, False
                                yield ('text', ev.delta.text)
                    final = await stream.get_final_message()
            except self._anthropic.BadRequestError as e:
                text = str(e).lower()
                if 'container' in extra and 'container' in text and not wrote:
                    # The sandbox is gone (expired early, or deleted): start a new one.
                    extra.pop('container')
                    _CLAUDE_CONTAINERS.pop(conversation_key, None)
                    continue
                # Refused before anything streamed: drop an option the model
                # doesn't take and ask again; the refusal is remembered.
                key = next((k for k in ('effort', 'fallbacks') if k in text and k not in refused
                            and (k in extra or (k == 'effort' and 'output_config' in extra))), None)
                if key is None or wrote:
                    raise LlmError(f'Claude: {e}') from e
                refused.add(key)
                extra.pop('output_config' if key == 'effort' else key, None)
                if key == 'fallbacks':
                    params['betas'] = [b for b in params.get('betas', []) if not b.startswith('server-side-fallback')]
                continue
            except self._anthropic.APIError as e:
                raise LlmError(f'Claude: {e}') from e
            ran_in = getattr(final, 'container', None)
            if sandbox and ran_in is not None and getattr(ran_in, 'id', None):
                _CLAUDE_CONTAINERS[conversation_key] = (ran_in.id, getattr(ran_in, 'expires_at', None))
                extra['container'] = ran_in.id   # a paused turn resumes in it
            for block in final.content:
                if block.type == 'tool_use':
                    yield ('tool_call', block.id, block.name, json.dumps(block.input or {}))
                elif block.type == 'mcp_tool_use':
                    mcp_uses[block.id] = block
                elif block.type == 'mcp_tool_result':
                    use = mcp_uses.get(block.tool_use_id)
                    output = ''.join(getattr(c, 'text', '') or '' for c in block.content or []) \
                        if isinstance(block.content, list) else str(block.content or '')
                    hosted.append({'type': 'mcp_call', 'id': block.tool_use_id,
                                   'name': use.name if use else 'mcp',
                                   'arguments': json.dumps(use.input or {}) if use else '',
                                   'output': '' if block.is_error else output,
                                   'error': (output or 'failed') if block.is_error else None,
                                   'status': 'failed' if block.is_error else 'completed'})
                elif block.type == 'server_tool_use':
                    server_uses[block.id] = block
                elif block.type in ('web_search_tool_result', 'web_fetch_tool_result',
                                    'bash_code_execution_tool_result'):
                    use = server_uses.get(block.tool_use_id)
                    if use is not None:
                        hosted.append(_claude_server_call(use, block))
                    if block.type == 'bash_code_execution_tool_result':
                        # Files the command left in $OUTPUT_DIR (the tool's
                        # own description tells Claude to share files that way).
                        result = block.content
                        if getattr(result, 'type', '') == 'bash_code_execution_result':
                            made.extend(f.file_id for f in result.content or [] if getattr(f, 'file_id', None))
            # The size of the conversation as sent: message_start's usage,
            # before Anthropic's server-tool loop read search results and
            # pages into the request - those aren't resent next time, and
            # counting them made one search look like a full conversation
            # (a summary straight after every search turn, 2026-10-02).
            u = sent or final.usage
            cached = u.cache_read_input_tokens or 0
            yield ('usage', {'input_tokens': (u.input_tokens or 0) + cached + (u.cache_creation_input_tokens or 0),
                             'output_tokens': final.usage.output_tokens or 0,
                             'input_tokens_details': {'cached_tokens': cached}})
            if final.stop_reason == 'pause_turn':
                # Anthropic's server-tool loop hit its turn limit: send the
                # paused turn back as it is and it carries on.
                params['messages'] = params['messages'] + [
                    {'role': 'assistant', 'content': [b.model_dump(exclude_none=True) for b in final.content]}]
                continue
            if final.stop_reason == 'refusal' and not wrote:
                details = getattr(final, 'stop_details', None)
                raise LlmError(f"Claude declined to answer ({getattr(details, 'category', None) or 'refusal'})")
            break
        for item in hosted:
            yield ('hosted_call', item)
        for file_id in made:
            yield ('file', file_id)

    async def close(self):
        await self._client.close()


ENGINES = [XaiLlm, OpenAiLlm, OpenAiCloudLlm, AnthropicLlm]
