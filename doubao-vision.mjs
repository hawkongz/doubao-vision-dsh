// doubao-vision.mjs — host-level plugin: route chat images through desktop Doubao.
//
// Loaded from $DSH_HOME/cordis.patch.yml (machine-local user plugin layer,
// applied to every profile and hot-reloaded). Toggle it by editing the row's
// `disabled` flag in that file; the change applies live, no restart.
//
// When a user message with an image block enters a step, this plugin sends the
// image to the desktop Doubao app (CDP) and replaces the image block with the
// text Doubao returns, so a text-only model route can "see" images.
//
// It also advertises the image input modality on registered model adapters so
// the host's session.prompt admission accepts image uploads (metadata only;
// the real request path stays text-only), and denies the built-in read_image
// tool whose image blocks the text-only adapter would reject.
//
// Code changes to this file require a process restart (ESM cache); toggling
// the row's `disabled` flag in cordis.patch.yml is hot.
import { writeFileSync, mkdtempSync, appendFileSync, statSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const DEFAULT_DOUBAO_EXE = 'C:\\Users\\20105\\AppData\\Local\\Doubao\\Application\\app\\Doubao.exe'
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe'
const TASKKILL_EXE = 'C:\\Windows\\System32\\taskkill.exe'
const CDP_PORT = 9225
const DEFAULT_QUESTION = '请详细描述这张图片的内容,包括图中的文字信息'

const PATCHED = Symbol.for('doubao-vision.patched')
const LOG_FILE = 'C:\\Users\\20105\\.dsh\\plugins\\doubao-vision.log'
// Human-browsable folder where every chat image gets a copy with a readable
// name (date_sha8.ext). The raw cache itself lives in
// $DSH_HOME/attachments/v1/objects/<sha2>/<sha256>.
const DSH_HOME_ROOT = String(process.env.DSH_HOME || 'C:\\Users\\20105\\.dsh')
const COLLECT_DIR = join(DSH_HOME_ROOT, 'attachments', 'collected')
let patchRefs = 0
let globalAdapters = null
let globalOffUpdated = null

function logLine(msg) {
  try {
    const line = new Date().toISOString() + ' ' + msg + '\n'
    try {
      if (statSync(LOG_FILE).size > 200000) writeFileSync(LOG_FILE, '')
    } catch (e) {}
    appendFileSync(LOG_FILE, line)
  } catch (e) {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Hard cap for ANY single wait: even if some step hangs for an unknown reason,
// the turn can never block longer than `ms`. The stop button additionally
// aborts through `signal` when the framework aborts it.
function withTimeout(promise, ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('识别等待超时(' + Math.round(ms / 1000) + '秒),已放弃')), ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('已取消'))
    }
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new Error('已取消'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (v) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function addImageModality(info) {
  if (info && Array.isArray(info.inputModalities) && !info.inputModalities.includes('image')) {
    return { ...info, inputModalities: [...info.inputModalities, 'image'] }
  }
  return info
}

function patchAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || adapter[PATCHED]) return
  const originals = {}
  let patchedAny = false
  if (typeof adapter.resolveModel === 'function') {
    originals.resolveModel = adapter.resolveModel
    try {
      adapter.resolveModel = async function (provider, model, signal) {
        const info = await originals.resolveModel.call(this, provider, model, signal)
        return addImageModality(info)
      }
      patchedAny = true
    } catch (e) {}
  }
  if (typeof adapter.listModels === 'function') {
    originals.listModels = adapter.listModels
    try {
      adapter.listModels = async function (provider) {
        const models = await originals.listModels.call(this, provider)
        if (!Array.isArray(models)) return models
        return models.map((m) => addImageModality(m))
      }
      patchedAny = true
    } catch (e) {}
  }
  // Strip image blocks from every outgoing model request: the transcript and
  // the chat UI keep the picture, but the text-only provider route must never
  // receive it (its adapter would reject image content blocks).
  if (typeof adapter.stream === 'function') {
    originals.stream = adapter.stream
    try {
      adapter.stream = function (options) {
        const messages = options && options.messages
        if (!Array.isArray(messages)) return originals.stream.call(this, options)
        let changed = false
        const sanitized = messages.map((m) => {
          if (!m || !Array.isArray(m.content) || !m.content.some((b) => b && b.type === 'image')) return m
          changed = true
          return { ...m, content: m.content.filter((b) => !(b && b.type === 'image')) }
        })
        if (!changed) return originals.stream.call(this, options)
        logLine('adapter stream: stripped image blocks from request messages')
        return originals.stream.call(this, { ...options, messages: sanitized })
      }
      patchedAny = true
    } catch (e) {}
  }
  if (patchedAny) {
    adapter[PATCHED] = originals
  }
}

function restoreAllAdapters() {
  try {
    if (globalAdapters && typeof globalAdapters.forEach === 'function') {
      globalAdapters.forEach((reg) => {
        const adapter = reg && reg.adapter
        const originals = adapter && adapter[PATCHED]
        if (!originals) return
        for (const name of Object.keys(originals)) {
          try { adapter[name] = originals[name] } catch (e) {}
        }
        try { delete adapter[PATCHED] } catch (e) {}
      })
    }
  } catch (e) {}
}

// ── CDP bridge (in-process) ─────────────────────────────────────────────────

function findChatTarget(targets) {
  const pages = (targets || []).filter((t) => t.type === 'page')
  const chat = pages.find((t) => t.url.indexOf('doubao://doubao-chat/chat') === 0)
  if (chat) return chat
  const anyChat = pages.find((t) => t.url.indexOf('doubao://doubao-chat') === 0)
  if (anyChat) return anyChat
  const launcher = pages.find((t) => t.url.indexOf('doubao-launcher/chat') >= 0)
  if (launcher) return launcher
  return pages[0]
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.id = 0
    this.pending = new Map()
  }
  connect(timeoutMs) {
    const self = this
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(self.wsUrl)
      self.ws = ws
      const to = setTimeout(() => {
        try { ws.close() } catch (e) {}
        reject(new Error('CDP connect timeout'))
      }, timeoutMs || 10000)
      ws.onopen = () => { clearTimeout(to); resolve() }
      ws.onerror = () => { clearTimeout(to); reject(new Error('CDP websocket error')) }
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data)
        if (msg.id && self.pending.has(msg.id)) {
          const entry = self.pending.get(msg.id)
          self.pending.delete(msg.id)
          if (msg.error) entry.reject(new Error('CDP ' + (msg.error.message || JSON.stringify(msg.error))))
          else entry.resolve(msg.result)
        }
      }
    })
  }
  send(method, params, timeoutMs) {
    const self = this
    return new Promise((resolve, reject) => {
      const msgId = ++self.id
      self.pending.set(msgId, { resolve, reject })
      try {
        self.ws.send(JSON.stringify({ id: msgId, method, params: params || {} }))
      } catch (e) {
        self.pending.delete(msgId)
        reject(e)
        return
      }
      setTimeout(() => {
        if (self.pending.has(msgId)) {
          self.pending.delete(msgId)
          reject(new Error('CDP timeout: ' + method))
        }
      }, timeoutMs || 8000)
    })
  }
  close() {
    try { this.ws.close() } catch (e) {}
  }
}

async function evaluate(cdp, expression, timeoutMs) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs || 8000)
  if (r.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text))
  }
  return r.result.value
}

async function setFileInput(cdp, filePath) {
  const doc = await cdp.send('DOM.getDocument', { depth: 1 })
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[data-testid="upload-file-input"]' })
  if (!q.nodeId) throw new Error('upload-file-input not found in DOM')
  await cdp.send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [filePath] })
}

function injectTextScript(text) {
  return '(function(t){var ta=document.querySelector(\'[data-testid="chat_input_input"]\');'
    + 'if(!ta)return {ok:false,error:"No textarea found"};ta.focus();'
    + 'var d=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value");'
    + 'var s=d&&d.set;if(s)s.call(ta,t);else ta.value=t;'
    + 'ta.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'ta.dispatchEvent(new Event("change",{bubbles:true}));'
    + 'return {ok:true};})(' + JSON.stringify(text) + ')'
}

const CLICK_SEND = '(function(){'
  + 'var b=document.querySelector(\'[data-testid="chat_input_send_button"]\');'
  + 'if(b){b.click();return "clicked";}'
  + 'var ta=document.querySelector(\'[data-testid="chat_input_input"]\');'
  + 'if(!ta)return "none";'
  + 'var k=new KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true});'
  + 'ta.dispatchEvent(k);'
  + 'var u=new KeyboardEvent("keyup",{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true});'
  + 'ta.dispatchEvent(u);return "enter-key";})()'

// The message list is virtualized (old entries leave the DOM), so counting is unreliable.
// Every message node carries a unique data-message-id. Poll for the LAST rendered message
// being an assistant message with non-empty ANSWER text whose id differs from the pre-send
// baseline.
//
// Doubao renders a thinking block ("正在思考" / streaming CoT) as the FIRST child of the
// message's column container and the real answer as the LAST child. The old code grabbed
// the thinking text and returned it as the answer; now the answer is only accepted once
// the thinking block shows a completed label and the answer section has text.
function lastMessageScript(baselineId) {
  return '(function(baseline){'
    + 'var ms=document.querySelectorAll(\'[data-testid="message_content"]\');'
    + 'if(ms.length===0)return {phase:"waiting",text:null};'
    + 'var last=ms[ms.length-1];'
    + 'var isUser=!!(last.classList&&last.classList.contains("justify-end"));'
    + 'if(isUser)return {phase:"waiting",text:null};'
    + 'var id=last.getAttribute("data-message-id")||"";'
    + 'var col=null;'
    + 'var divs=last.querySelectorAll("div");'
    + 'for(var i=0;i<divs.length;i++){'
    + 'var el=divs[i];'
    + 'if(el.children.length>=2){'
    + 'var t=(el.children[0].textContent||"").trim();'
    + 'if(t.indexOf("正在")===0||t.indexOf("思考中")>=0||t.indexOf("深度思考")===0||t.indexOf("已完成思考")===0||t.indexOf("已深度思考")===0){col=el;break;}'
    + '}'
    + '}'
    + 'var answerEl=null;'
    + 'if(col){'
    + 'var t0=(col.children[0].textContent||"").trim();'
    + 'if(t0.indexOf("正在")===0||t0.indexOf("思考中")>=0||t0.indexOf("深度思考")===0)return {phase:"waiting",text:null};'
    + 'var best=null,bestLen=-1;'
    + 'for(var k=1;k<col.children.length;k++){var cl=col.children[k];var l=(cl.textContent||"").length;if(l>bestLen){bestLen=l;best=cl;}}'
    + 'answerEl=best||col.children[col.children.length-1];'
    + '}else{'
    + 'var tl=(last.textContent||"").trim();'
    + 'if(tl.indexOf("正在")===0||tl.indexOf("思考中")>=0||tl.indexOf("深度思考")===0)return {phase:"waiting",text:null};'
    + 'answerEl=last;'
    + '}'
    + 'var text="";'
    + 'var kids=answerEl.querySelectorAll("div[dir]");'
    + 'if(kids.length>0){var parts=[];for(var j=0;j<kids.length;j++){parts.push(kids[j].innerText||kids[j].textContent||"");}text=parts.join("");}'
    + 'else{text=(answerEl.innerText||answerEl.textContent||"").trim();}'
    + 'var fresh=text&&(id!==baseline);'
    + 'return {phase:fresh?"done":"waiting",text:text,id:id};'
    + '})(' + JSON.stringify(baselineId) + ')'
}

const CLICK_NEW_CHAT = '(function(){'
  + 'var b=document.querySelector(\'[data-testid="new_chat_button"]\');'
  + 'if(b){b.click();return true;}'
  + 'var s=document.querySelector(\'[data-testid="app-open-newChat"]\');'
  + 'if(s){s.click();return true;}'
  + 'return false;})()'

// The chat page is usable once its input box AND upload control are rendered.
// A freshly launched Doubao renders the textarea first and the upload input a
// moment later, so "endpoint up" and "textarea up" are NOT "ready to send an
// image" — both must exist before we attach a file.
const INPUT_READY_SCRIPT = '(function(){'
  + 'var ta=document.querySelector(\'[data-testid="chat_input_input"]\');'
  + 'var up=document.querySelector(\'[data-testid="upload-file-input"]\');'
  + 'return {textarea:!!ta, upload:!!up};'
  + '})()'

// A send landed once a fresh USER message is rendered (the message we just sent).
// Requiring the user role rejects the false positive where a still-streaming
// assistant message is re-rendered with a new id.
function sentCheckScript(baselineId) {
  return '(function(baseline){'
    + 'var ms=document.querySelectorAll(\'[data-testid="message_content"]\');'
    + 'for(var i=0;i<ms.length;i++){'
    + 'var id=(ms[i].getAttribute("data-message-id"))||"";'
    + 'var isUser=!!(ms[i].classList&&ms[i].classList.contains("justify-end"));'
    + 'if(id&&id!==baseline&&isUser)return {sent:true};'
    + '}'
    + 'return {sent:false};'
    + '})(' + JSON.stringify(baselineId) + ')'
}

// Whether the chat is safe to send into: the last rendered message must not be an
// assistant turn that is still thinking or still streaming its answer text.
const PREV_TURN_SCRIPT = '(function(){'
  + 'var ms=document.querySelectorAll(\'[data-testid="message_content"]\');'
  + 'if(ms.length===0)return "ready";'
  + 'var last=ms[ms.length-1];'
  + 'var isUser=!!(last.classList&&last.classList.contains("justify-end"));'
  + 'if(isUser)return "ready";'
  + 'var t=(last.textContent||"").trim();'
  + 'if(t.indexOf("正在")===0||t.indexOf("思考中")>=0||t.indexOf("深度思考")===0)return "busy";'
  + 'return "ready";'
  + '})()'

const PREV_TURN_TEXT_SCRIPT = '(function(){'
  + 'var ms=document.querySelectorAll(\'[data-testid="message_content"]\');'
  + 'if(!ms.length)return "";'
  + 'var last=ms[ms.length-1];'
  + 'var t=(last.textContent||"").trim();'
  + 'return t.slice(-2000);'
  + '})()'

// Wait until the previous assistant turn is truly finished (thinking block done AND
// answer text stable across two samples). Sending while Doubao is still generating
// gets the new message silently dropped.
async function awaitPreviousTurn(cdp, timeoutMs, signal) {
  const deadline = Date.now() + (timeoutMs || 30000)
  let prevText = null
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error('已取消')
    let state = null
    let text = null
    try { state = await evaluate(cdp, PREV_TURN_SCRIPT, 4000) } catch (e) {}
    try { text = await evaluate(cdp, PREV_TURN_TEXT_SCRIPT, 4000) } catch (e) {}
    if (state === 'ready') {
      if (prevText !== null && text === prevText) return true
      prevText = text
    } else {
      prevText = null
    }
    await sleep(900)
  }
  return false
}

// The last rendered message's id, role-independent (pre-send baseline).
const LAST_ID_SCRIPT = '(function(){'
  + 'var ms=document.querySelectorAll(\'[data-testid="message_content"]\');'
  + 'if(!ms.length)return "";'
  + 'return ms[ms.length-1].getAttribute("data-message-id")||"";'
  + '})()'

async function awaitInput(cdp, timeoutMs, needUpload, signal) {
  const deadline = Date.now() + (timeoutMs || 8000)
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return false
    let r
    try { r = await evaluate(cdp, INPUT_READY_SCRIPT, 4000) } catch (e) { r = null }
    if (r && r.textarea && (!needUpload || r.upload)) return true
    await sleep(800)
  }
  return false
}

// One fast readiness probe (fresh target, tight timeouts). This is the
// hot path of the startup poll: keep it under ~7s even when the page hangs.
async function quickProbe(signal) {
  if (signal && signal.aborted) return false
  let target
  try {
    target = await chatTarget()
  } catch (e) {
    return false
  }
  const cdp = new CdpClient(target.webSocketDebuggerUrl)
  try {
    await cdp.connect(2000)
    const r = await evaluate(cdp, INPUT_READY_SCRIPT, 4000)
    return !!(r && r.textarea && r.upload)
  } catch (e) {
    return false
  } finally {
    cdp.close()
  }
}

// Slower one-shot recovery: click "new chat" once, then wait for the input.
async function prepareChatPage(signal) {
  if (await quickProbe(signal)) return true
  if (signal && signal.aborted) return false
  let target
  try {
    target = await chatTarget()
  } catch (e) {
    return false
  }
  const cdp = new CdpClient(target.webSocketDebuggerUrl)
  try {
    await cdp.connect(2000)
    try { await evaluate(cdp, CLICK_NEW_CHAT, 4000) } catch (e) {}
    await sleep(800)
    return await awaitInput(cdp, 8000, true, signal)
  } catch (e) {
    return false
  } finally {
    cdp.close()
  }
}

async function chatTarget() {
  const res = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list', { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error('CDP HTTP ' + res.status)
  const targets = await res.json()
  const target = findChatTarget(targets)
  if (!target) throw new Error('No Doubao chat page target found')
  return target
}

// Send imageB64 (+prompt) to Doubao and read back the fresh assistant reply.
// `signal` is the turn's abort signal: every wait respects it, so the user's
// "stop" cancels recognition immediately instead of hanging the turn.
async function doubaoAsk({ imageB64, mimeType, prompt, timeoutMs, signal }) {
  logLine('doubaoAsk enter (image=' + !!imageB64 + ', prompt=' + JSON.stringify(String(prompt || '').slice(0, 40)) + ')')
  const target = await chatTarget()
  const cdp = new CdpClient(target.webSocketDebuggerUrl)
  await cdp.connect()
  try {
    // A freshly relaunched Doubao may still be loading its UI; wait for the
    // chat input, and if the app landed on a non-chat view, open a new chat.
    let ready = await awaitInput(cdp, 8000, false, signal)
    if (!ready) {
      if (signal && signal.aborted) throw new Error('已取消')
      try { await evaluate(cdp, CLICK_NEW_CHAT, 4000) } catch (e) {}
      await sleep(800)
      ready = await awaitInput(cdp, 8000, false, signal)
    }
    if (!ready) throw new Error('豆包聊天界面未就绪(应用刚启动或停留在首页),请稍后重试')
    // Sending while the previous turn is still generating gets silently dropped.
    const prevOk = await awaitPreviousTurn(cdp, 30000, signal)
    if (!prevOk) throw new Error('豆包上一轮回答仍在生成中,请稍后重试')
    let imagePath = null
    if (imageB64) {
      const mime = mimeType || 'image/png'
      let ext = mime.split('/')[1] || 'png'
      if (ext === 'jpeg') ext = 'jpg'
      const dir = mkdtempSync(join(tmpdir(), 'dbimg-'))
      imagePath = join(dir, 'img.' + ext)
      writeFileSync(imagePath, Buffer.from(imageB64, 'base64'))
    }
    // Baseline = last message id regardless of role; retried because the page
    // may still be re-rendering right after launch. This guards the reply poll
    // against mistaking a restored/old message for our fresh reply.
    let baselineId = ''
    for (let attempt = 0; attempt < 3 && !baselineId; attempt++) {
      if (signal && signal.aborted) throw new Error('已取消')
      try {
        const id = await evaluate(cdp, LAST_ID_SCRIPT, 4000)
        if (typeof id === 'string' && id) baselineId = id
      } catch (e) {
        await sleep(800)
      }
    }
    logLine('doubaoAsk baseline=' + JSON.stringify(baselineId))
    if (imagePath) {
      // Cold start renders the upload control later than the textarea; wait
      // for it and retry instead of giving up (clicking new-chat is pointless
      // here — a fresh Doubao already opens a new conversation).
      let attached = false
      for (let attempt = 0; attempt < 3 && !attached; attempt++) {
        if (signal && signal.aborted) throw new Error('已取消')
        try {
          await setFileInput(cdp, imagePath)
          attached = true
          logLine('doubaoAsk setFileInput ok on attempt ' + (attempt + 1))
        } catch (e) {
          logLine('doubaoAsk setFileInput attempt ' + (attempt + 1) + ' failed: ' + (e && e.message))
          for (let i = 0; i < 8; i++) {
            if (signal && signal.aborted) throw new Error('已取消')
            await sleep(1000)
            let r = null
            try { r = await evaluate(cdp, INPUT_READY_SCRIPT, 4000) } catch (e2) {}
            if (r && r.upload) break
          }
        }
      }
      if (!attached) throw new Error('豆包图片上传控件不可用(界面未就绪),请稍后重试')
      await sleep(1000)
    }
    if (prompt) {
      // The file-attachment overlay (cold start / fresh upload) can re-render
      // the input and drop our injected value; verify and retry before send.
      let injected = false
      for (let attempt = 0; attempt < 3 && !injected; attempt++) {
        if (signal && signal.aborted) throw new Error('已取消')
        const inj = await evaluate(cdp, injectTextScript(prompt), 4000)
        if (!inj || inj.ok === false) throw new Error('Could not inject prompt: ' + (inj && inj.error || 'unknown'))
        await sleep(300)
        let value = null
        try {
          value = await evaluate(cdp, 'document.querySelector(\'[data-testid="chat_input_input"]\') ? document.querySelector(\'[data-testid="chat_input_input"]\').value : null', 4000)
        } catch (e) {}
        if (value === prompt) injected = true
        else logLine('doubaoAsk prompt inject attempt ' + (attempt + 1) + ' value mismatch: ' + JSON.stringify(String(value).slice(0, 40)))
      }
      if (!injected) throw new Error('Could not inject prompt (input kept being reset)')
      const how = await evaluate(cdp, CLICK_SEND, 4000)
      if (how === 'none') throw new Error('No input box found to send')
    } else if (!imagePath) {
      throw new Error('Nothing to send: no image and no prompt')
    } else {
      const how = await evaluate(cdp, CLICK_SEND, 4000)
      if (how === 'none') throw new Error('No send control found')
    }
    // Fail fast instead of hanging until the reply deadline when the send
    // never lands (e.g. the page changed under us during startup).
    const sentDeadline = Date.now() + 20000
    let sent = false
    while (Date.now() < sentDeadline) {
      if (signal && signal.aborted) throw new Error('已取消')
      await sleep(800)
      try {
        const check = await evaluate(cdp, sentCheckScript(baselineId), 4000)
        if (check && check.sent) { sent = true; break }
      } catch (e) {}
    }
    if (!sent) {
      logLine('doubaoAsk sentinel FAILED (no fresh message within 20s)')
      throw new Error('消息未能发送到豆包(界面可能刚切换),请重试')
    }
    logLine('doubaoAsk sentinel ok')
    const deadline = Date.now() + (timeoutMs || 120000)
    let lastText = ''
    let lastId = ''
    let stableSince = 0
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw new Error('已取消')
      await sleep(800)
      let res
      try {
        res = await evaluate(cdp, lastMessageScript(baselineId), 4000)
      } catch (e) {
        continue
      }
      if (res && res.phase === 'done' && res.text) {
        if (res.text === lastText && res.id === lastId) {
          stableSince += 800
          if (stableSince >= 1600) {
            logLine('doubaoAsk reply done id=' + res.id)
            return res.text
          }
        } else {
          lastText = res.text
          lastId = res.id
          stableSince = 0
        }
      }
    }
    if (lastText) return lastText
    throw new Error('timeout waiting for reply')
  } finally {
    cdp.close()
  }
}

async function probeCdp() {
  try {
    await chatTarget()
    return true
  } catch (e) {
    return false
  }
}

async function relaunchDoubao(doubaoExe, signal) {
  logLine('relaunch: taskkill + start ' + doubaoExe)
  // Hard 20s cap per command + abort wiring: a frozen Doubao can make
  // taskkill/start block for minutes, which previously hung the whole turn
  // with no way for the stop button to interrupt it.
  const opts = { timeout: 20000, ...(signal ? { signal } : {}) }
  try {
    await execFileP(TASKKILL_EXE, ['/F', '/IM', 'Doubao.exe'], opts)
  } catch (e) {
    logLine('relaunch: taskkill failed: ' + String((e && e.message) || e))
  }
  if (signal && signal.aborted) return false
  await sleep(1500)
  try {
    await execFileP(CMD_EXE, ['/c', 'start', '', doubaoExe, '--remote-debugging-port=' + CDP_PORT], opts)
  } catch (e) {
    logLine('relaunch: start failed: ' + String((e && e.message) || e))
  }
  return true
}

async function ensureCdp(doubaoExe, signal) {
  if (signal && signal.aborted) return false
  if (await quickProbe(signal)) return true
  if (signal && signal.aborted) return false
  logLine('doubao not ready, relaunching')
  await relaunchDoubao(doubaoExe, signal)
  const deadline = Date.now() + 75000
  let poll = 0
  while (Date.now() < deadline) {
    if (signal && signal.aborted) { logLine('ensureCdp aborted'); return false }
    await sleep(1000)
    poll++
    if (await quickProbe(signal)) {
      logLine('doubao ready after relaunch (poll ' + poll + ')')
      return true
    }
  }
  if (!(signal && signal.aborted) && Date.now() < deadline && await prepareChatPage(signal)) return true
  logLine('doubao relaunch gave up')
  return false
}

function mediaTypeForPath(path) {
  const lower = String(path || '').toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return null
}

// Detect an image's media type from magic bytes (used when we read the stored
// object file directly and have no reference metadata).
function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

// Read the content-addressed object file for an attachmentId, or null.
function attachmentBytesById(attachmentId) {
  const m = /^sha256:([a-f0-9]{64})$/.exec(String(attachmentId || ''))
  if (!m) return null
  for (const p of [
    join(DSH_HOME_ROOT, 'attachments', 'v1', 'objects', m[1].slice(0, 2), m[1]),
    join(DSH_HOME_ROOT, 'attachments', 'objects', m[1].slice(0, 2), m[1]),
  ]) {
    try {
      const buf = readFileSync(p)
      if (buf && buf.length > 0) return buf
    } catch (e) {}
  }
  return null
}

// Copy image bytes into one human-browsable folder with a readable name;
// deduped by content hash, so re-sending the same image never piles up.
function collectImageBytes(bytes) {
  try {
    if (!bytes || bytes.length === 0) return null
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
    const ext = extMap[sniffMediaType(bytes)] || 'bin'
    const hash = createHash('sha256').update(bytes).digest('hex')
    mkdirSync(COLLECT_DIR, { recursive: true })
    const existing = readdirSync(COLLECT_DIR).find((n) => n.indexOf(hash.slice(0, 8)) >= 0)
    if (existing) return join(COLLECT_DIR, existing)
    const stamp = new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19)
    const dest = join(COLLECT_DIR, stamp + '_' + hash.slice(0, 8) + '.' + ext)
    writeFileSync(dest, bytes)
    logLine('collect: ' + dest + ' (' + bytes.length + ' bytes)')
    return dest
  } catch (e) {
    logLine('collect failed: ' + String((e && e.message) || e))
    return null
  }
}

function sessionCwdOf(exec) {
  try {
    const agent = exec && exec.agent
    if (agent && agent.session && agent.session.header) return agent.session.header.cwd || ''
  } catch (e) {}
  return ''
}

async function resolveImageTarget(fs, rawPath, signal, sessionCwd, hostWorkspaceRoot) {
  const candidates = []
  if (sessionCwd) candidates.push({ path: String(rawPath), opts: { cwd: sessionCwd } })
  candidates.push({ path: String(rawPath), opts: {} })
  if (hostWorkspaceRoot) candidates.push({ path: String(rawPath), opts: { cwd: hostWorkspaceRoot } })
  const seen = new Set()
  const notes = []
  for (const cand of candidates) {
    try {
      const target = await fs.resolve(cand.path, { signal, ...cand.opts })
      const key = String(target.targetKey)
      if (seen.has(key)) continue
      seen.add(key)
      const info = await fs.stat(target, signal)
      if (info && info.type === 'file') return target
      notes.push(target.displayPath + ' -> ' + (info ? info.type : 'absent'))
    } catch (e) {
      notes.push(String((e && e.message) || e))
    }
  }
  throw new Error('无法定位图片文件: ' + rawPath + ' | ' + notes.join(' | '))
}

export default {
  name: 'doubao-vision',
  apply(ctx, config) {
    try {
    logLine('apply: doubao-vision loaded')
    // Optional service reads: if a future DSH version renames these, the
    // plugin disables itself silently instead of blocking app boot.
    const tools = ctx.get('tools')
    const attachments = ctx.get('attachments')
    const fs = ctx.get('fs')
    const llm = ctx.get('llm')
    if (!tools || !attachments || !fs || !llm) {
      logLine('apply: a required service is missing (newer DSH version?); plugin disabled itself')
      return
    }
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const hostWorkspaceRoot = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' ? sandboxPolicy.workspaceRoot : ''
    const doubaoExe = (config && typeof config.doubaoExe === 'string' && config.doubaoExe) || DEFAULT_DOUBAO_EXE

    // Tell every session's model (globally, every preset) that images must go
    // through the Doubao tools — so agents proactively use them for screenshot
    // analysis instead of relying on tool-schema discovery alone.
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        systemPrompt.section({
          name: 'doubao-vision:capability',
          order: 5,
          text: '本环境的模型无法直接查看图片。需要分析截图或图片时,优先调用 doubao_vision 工具(传入图片文件路径),它会交给桌面豆包识别并返回文字结果;当用户直接在聊天里发送图片时,图片块会从模型请求中移除,该图的附件 ID 会在系统提示的 doubao-vision:step-images 一节按顺序列出,此时必须调用 doubao_recognize_attachment 工具(attachment_id 填该节列出的值;若用户提到更早的图片而你没有其 ID,可省略 attachment_id,默认识别本会话最近一张图,或请用户重发)拿到识别文字后再回答用户。question 参数不要机械照抄用户原话:先读完用户说的话并判断他的意图 —— 只想要图中文字就问"提取图中所有文字";想看画面内容就让它详细描述;是针对图片提问就把问题改写得更明确(可补充必要上下文);拿不准时宁可让它详细描述图片内容。桌面豆包未运行时这两个工具会自动拉起它。',
        })
      } catch (e) {
        logLine('apply: systemPrompt section registration failed: ' + String((e && e.message) || e))
      }
    }
    const recogCache = new Map()
    // Full attachment refs captured when messages enter, keyed by attachmentId:
    // attachments.readImage verifies bytes/width/height against the reference,
    // so the tool needs the complete ref, not just the id.
    const refById = new Map()
    // Most recent image attachment per session, so the recognition tool can
    // default to it when the model has no id at hand (older-image follow-ups).
    const lastBySession = new Map()
    // Messages claimed by an agent step, consumed by the system-prompt
    // injection listener right below (claim → assemble is one synchronous
    // pair per step, so a FIFO is safe).
    const claimedQueue = []
    let chain = Promise.resolve()

    function withLock(fn) {
      const run = chain.then(fn, fn)
      chain = run.then(() => {}, () => {})
      return run
    }

    const collectSoon = (fn) => { setImmediate(() => { try { fn() } catch (e) {} }) }

    // Track image messages as each agent step claims them. The agent-loop
    // claims synchronously and immediately assembles the system prompt for
    // that exact step, so the assemble listener below can drain this queue.
    ctx.on('agent/inbox/claimed', (payload) => {
      try {
        const message = payload && payload.message
        if (message && message.content && message.content.some((b) => b && b.type === 'image')) {
          claimedQueue.push({ message, time: Date.now() })
          logLine('claimed image message queued (queue=' + claimedQueue.length + ')')
        }
      } catch (e) {}
    })

    // Inject per-step image attachment ids into the SYSTEM PROMPT instead of
    // the user message: the model still learns which image to recognize, but
    // the user's chat shows only the picture — no marker line at all.
    if (systemPrompt) {
      ctx.on('system-prompt/assemble', (assembly, context, next) => {
        try {
          const now = Date.now()
          const msgs = []
          while (claimedQueue.length > 0) {
            const entry = claimedQueue.shift()
            if (now - entry.time > 10000) continue
            msgs.push(entry.message)
          }
          const ids = []
          for (const m of msgs) {
            for (const b of m.content) {
              if (b && b.type === 'image' && b.attachment && b.attachment.attachmentId) ids.push(b.attachment.attachmentId)
            }
          }
          logLine('assemble hook: drained ' + msgs.length + ' message(s), found ' + ids.length + ' image id(s)')
          if (ids.length > 0 && assembly && Array.isArray(assembly.sections)) {
            assembly.sections.push({
              name: 'doubao-vision:step-images',
              text: '本条消息包含 ' + ids.length + ' 张图片(图片块已从消息中移除,因此某条用户消息可能看起来是空的)。附件 ID 按出现顺序:' + ids.map((id, i) => '图片' + (i + 1) + '=' + id).join(';') + '。请调用 doubao_recognize_attachment 工具识别后再回答用户(识别与提问方法见 doubao-vision:capability 一节)。',
            })
            logLine('assemble hook: injected step-images section')
          }
        } catch (e) {
          logLine('system-prompt injection failed: ' + String((e && e.message) || e))
        }
        return next()
      }, { prepend: true })
    }

    // Fire-and-forget warm-up: when a message carries an image and Doubao is
    // down, (re)start it in the background WITHOUT delaying the step, so the
    // recognition tool call that follows finds it ready. The step itself stays
    // instant and cancellable.
    let warmStarted = false
    function warmDoubao() {
      if (warmStarted) return
      warmStarted = true
      Promise.resolve().then(async () => {
        try {
          if (!(await quickProbe())) {
            logLine('pre-step warm-up: relaunching doubao in background')
            await relaunchDoubao(doubaoExe)
            const warmDeadline = Date.now() + 90000
            while (Date.now() < warmDeadline) {
              await sleep(1000)
              if (await quickProbe()) { logLine('pre-step warm-up: ready'); break }
            }
          }
        } catch (e) {
          logLine('pre-step warm-up failed: ' + String((e && e.message) || e))
        }
      })
    }

    // Advertise image input on registered adapters so the host prompt admission
    // accepts image uploads. Only metadata is patched; the real stream path
    // stays text-only because the pre-step hook replaces image blocks first.
    function patchAllAdapters() {
      try {
        if (llm && llm.adapters && typeof llm.adapters.forEach === 'function') {
          llm.adapters.forEach((reg) => { if (reg) patchAdapter(reg.adapter) })
        }
      } catch (e) {}
    }
    if (patchRefs === 0) {
      globalAdapters = llm.adapters
      globalOffUpdated = ctx.on('llm/adapters-updated', patchAllAdapters)
      patchAllAdapters()
    }
    patchRefs++
    ctx.effect(() => () => {
      patchRefs--
      if (patchRefs <= 0) {
        patchRefs = 0
        try { if (typeof globalOffUpdated === 'function') globalOffUpdated() } catch (e) {}
        restoreAllAdapters()
        globalAdapters = null
        globalOffUpdated = null
      }
    })

    // The built-in read_image tool would pass its route gate once image modality
    // is advertised, but its image blocks would break the text-only adapter.
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec && exec.name === 'read_image') {
        return { kind: 'deny', reason: '此会话由桌面豆包代做图片识别:请改用 doubao_vision 工具传入图片路径,或直接在聊天中发送图片' }
      }
      return next()
    })

    // Image blocks stay in the composed messages so the chat UI shows the
    // picture unchanged; the attachment ids reach the model through the
    // per-step system-prompt section injected above, and the adapter stream
    // patch strips image blocks before the provider sees them. Recognition
    // itself runs inside a normal, cancellable tool call, and this hook never
    // waits on Doubao — it is instant, so the step can never hang here.
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (!decision || decision.kind !== 'enter') return decision
      let hasImage = false
      for (const m of decision.messages) {
        if (m && m.content && m.content.some((b) => b && b.type === 'image')) { hasImage = true; break }
      }
      if (!hasImage) return decision
      warmDoubao()
      const out = []
      for (const m of decision.messages) {
        if (!m || !m.content || !m.content.some((b) => b && b.type === 'image')) {
          out.push(m)
          continue
        }
        const blocks = []
        for (const b of m.content) {
          if (!b || b.type !== 'image') {
            blocks.push(b)
            continue
          }
          // Keep the image block itself so the chat UI keeps showing the
          // picture. The model never sees it — the adapter stream patch
          // strips image blocks before the provider receives the request.
          blocks.push(b)
          const ref = b.attachment
          if (!ref || !ref.attachmentId) {
            blocks.push({ type: 'text', text: '[图片] 附件引用缺失,无法识别' })
            continue
          }
          refById.set(ref.attachmentId, ref)
          const attachmentId0 = ref.attachmentId
          try {
            const sessionId = payload && payload.agent && payload.agent.session ? payload.agent.session.id : ''
            if (sessionId) lastBySession.set(String(sessionId), attachmentId0)
          } catch (e) {}
          collectSoon(() => {
            const buf = attachmentBytesById(attachmentId0)
            if (buf) collectImageBytes(buf)
          })
        }
        out.push({ id: m.id, role: m.role, content: blocks, source: m.source })
      }
      return { kind: 'enter', messages: out }
    })

    tools.register({
      name: 'doubao_vision',
      description: '把一张图片文件发送给桌面豆包(豆包必须已运行),并返回豆包的文字回答。用于识别截图、照片中的内容,或回答关于图片的问题。豆包未以调试端口运行时本工具会自动重启它。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          image_path: { type: 'string', description: '图片文件的路径(工作区内相对路径或绝对路径)' },
          question: { type: 'string', description: '要问豆包的问题;根据用户意图自行组织(如"提取图中文字"/"描述图片内容"),省略时默认让它详细描述图片内容' },
        },
        required: ['image_path'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok', 'text', 'error'],
        },
        render(args, value) {
          return [{ type: 'text', text: value.ok ? value.text : '豆包识别失败: ' + value.error }]
        },
      },
      timeoutMs: 200000,
      async execute(args, exec) {
        try {
          const imagePath = String((args && args.image_path) || '')
          if (!imagePath.trim()) return { ok: false, text: '', error: 'image_path 不能为空' }
          const mime = mediaTypeForPath(imagePath)
          if (!mime) return { ok: false, text: '', error: '不支持的图片格式,仅支持 png/jpg/jpeg/webp/gif' }
          const target = await resolveImageTarget(fs, imagePath, exec.signal, sessionCwdOf(exec), hostWorkspaceRoot)
          const maxBytes = (attachments.imageLimits && attachments.imageLimits.maxImageBytes) || 31457280
          const data = await fs.readBytes(target, exec.signal, maxBytes)
          if (data.length === 0) return { ok: false, text: '', error: '图片文件为空' }
          collectImageBytes(data)
          if (!(await withTimeout(ensureCdp(doubaoExe, exec.signal), 120000, exec.signal))) return { ok: false, text: '', error: '桌面豆包不可用:未以调试端口启动或未安装。可用 doubao_cdp restart 重启用调试端口启动豆包' }
          const text = await withLock(() => doubaoAsk({
            imageB64: Buffer.from(data).toString('base64'),
            mimeType: mime,
            prompt: args && args.question ? String(args.question) : '',
            timeoutMs: 180000,
            signal: exec.signal,
          }))
          return { ok: true, text, error: '' }
        } catch (e) {
          return { ok: false, text: '', error: (e && e.message) || String(e) }
        }
      },
    })

    tools.register({
      name: 'doubao_recognize_attachment',
      description: '识别聊天中用户直接发送的图片附件:把附件图片交给桌面豆包,返回豆包的文字描述。当用户在聊天里发图时,图片块不会传给模型,其附件 ID 会列在系统提示的 doubao-vision:step-images 一节,请据此填写 attachment_id;用户提到更早的图片而你没有其 ID 时可省略 attachment_id,默认识别本会话最近一张图。豆包未运行时本工具会自动重启它;执行中可被"停止"中断。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachment_id: { type: 'string', description: '图片附件的 ID(来自系统提示 doubao-vision:step-images 一节);省略时识别本会话最近发送的一张图片' },
          question: { type: 'string', description: '希望豆包针对图片回答的问题。根据用户意图自行组织(如"提取图中所有文字"、"详细描述图片内容"、或针对图中某部分提问),不要机械照抄用户原话;省略时让豆包详细描述图片内容' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok', 'text', 'error'],
        },
        render(args, value) {
          return [{ type: 'text', text: value.ok ? value.text : '识别失败: ' + value.error }]
        },
      },
      timeoutMs: 240000,
      async execute(args, exec) {
        try {
          let attachmentId = String((args && args.attachment_id) || '').trim()
          if (!attachmentId) {
            try {
              const sid = exec && exec.agent && exec.agent.session ? exec.agent.session.id : ''
              attachmentId = sid ? (lastBySession.get(String(sid)) || '') : ''
            } catch (e) {}
            if (!attachmentId) return { ok: false, text: '', error: '缺少 attachment_id,且本会话没有已记录的图片。请重新发送图片后再试' }
          }
          if (recogCache.has(attachmentId)) return { ok: true, text: recogCache.get(attachmentId), error: '' }
          logLine('recognize_attachment: reading ' + attachmentId)
          // attachments.readImage verifies stored metadata against the FULL
          // reference (mediaType/bytes/width/height), so prefer the complete
          // ref captured when the message entered this session.
          let stored = null
          const fullRef = refById.get(attachmentId)
          if (fullRef) {
            try {
              stored = await withTimeout(attachments.readImage(fullRef, exec.signal), 30000, exec.signal)
            } catch (e) {
              logLine('recognize_attachment: readImage(full ref) failed: ' + String((e && e.message) || e))
              stored = null
            }
          }
          if (!stored) {
            // Fallback: read the content-addressed object file directly and
            // sniff the media type from magic bytes.
            const match = /^sha256:([a-f0-9]{64})$/.exec(attachmentId)
            if (!match) return { ok: false, text: '', error: '附件 ID 格式无效: ' + attachmentId }
            let base = ''
            try {
              const dshHomePath = ctx.get('dshHomePath')
              base = typeof dshHomePath === 'function' ? String(dshHomePath('') || '') : String(process.env.DSH_HOME || 'C:\\Users\\20105\\.dsh')
            } catch (e) {
              base = String(process.env.DSH_HOME || 'C:\\Users\\20105\\.dsh')
            }
            const candidates = [
              join(base, 'attachments', 'v1', 'objects', match[1].slice(0, 2), match[1]),
              join(base, 'attachments', 'objects', match[1].slice(0, 2), match[1]),
            ]
            let data = null
            for (const p of candidates) {
              try {
                const buf = readFileSync(p)
                if (buf && buf.length > 0) { data = buf; break }
              } catch (e) {}
            }
            if (!data) return { ok: false, text: '', error: '找不到附件文件(存储缺失),请重新发送图片' }
            stored = { data, ref: { mediaType: sniffMediaType(data) || 'image/png' } }
            logLine('recognize_attachment: direct object read fallback, ' + data.length + ' bytes, ' + stored.ref.mediaType)
          }
          collectImageBytes(stored.data)
          logLine('recognize_attachment: read ' + (stored.data && stored.data.length) + ' bytes')
          const b64 = Buffer.from(stored.data).toString('base64')
          if (!(await withTimeout(ensureCdp(doubaoExe, exec.signal), 120000, exec.signal))) return { ok: false, text: '', error: '桌面豆包不可用(未以调试端口启动或未安装)。可用 doubao_cdp restart 重启豆包后重试' }
          const text = await withTimeout(withLock(() => doubaoAsk({
            imageB64: b64,
            mimeType: stored.ref && stored.ref.mediaType,
            prompt: args && args.question ? String(args.question) : '',
            timeoutMs: 180000,
            signal: exec.signal,
          })), 180000, exec.signal)
          recogCache.set(attachmentId, text)
          return { ok: true, text, error: '' }
        } catch (e) {
          return { ok: false, text: '', error: (e && e.message) || String(e) }
        }
      },
    })

    tools.register({
      name: 'doubao_cdp',
      description: '管理桌面豆包的 CDP 调试连接。action=status: 检查连接状态;action=restart: 以调试端口重启豆包(会关闭豆包当前窗口,历史对话保留);action=new-chat: 在豆包中开启新对话;action=ask: 在豆包当前对话中发送一段纯文字并返回回答。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', description: '要执行的操作:status / restart / new-chat / ask' },
          text: { type: 'string', description: 'ask 操作时要发送给豆包的文字' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok', 'text', 'error'],
        },
        render(args, value) {
          return [{ type: 'text', text: value.ok ? value.text : '操作失败: ' + value.error }]
        },
      },
      timeoutMs: 200000,
      async execute(args, exec) {
        try {
          const action = String((args && args.action) || '')
          if (action === 'status') {
            const endpoint = await probeCdp()
            if (!endpoint) return { ok: true, text: 'CDP 不可用(豆包未运行或未以调试端口启动)', error: '' }
            const ready = await prepareChatPage(exec.signal)
            return { ok: true, text: ready ? '豆包已运行,聊天界面就绪' : '豆包已运行,但聊天界面尚未就绪(可能仍在启动)', error: '' }
          }
          if (action === 'restart') {
            await relaunchDoubao(doubaoExe, exec.signal)
            if (exec.signal && exec.signal.aborted) return { ok: false, text: '', error: '已取消' }
            let ok = false
            const restartDeadline = Date.now() + 75000
            while (Date.now() < restartDeadline) {
              if (exec.signal && exec.signal.aborted) break
              await sleep(1000)
              if (await quickProbe(exec.signal)) { ok = true; break }
            }
            if (!ok && !(exec.signal && exec.signal.aborted)) ok = await prepareChatPage(exec.signal)
            return ok
              ? { ok: true, text: '豆包已带调试端口重启,聊天界面就绪', error: '' }
              : { ok: false, text: '', error: '重启后聊天界面仍未就绪(豆包可能仍在启动,请稍后再试)' }
          }
          if (action === 'new-chat') {
            const target = await chatTarget()
            const cdp = new CdpClient(target.webSocketDebuggerUrl)
            await cdp.connect(3000)
            try {
              const clicked = await evaluate(cdp, CLICK_NEW_CHAT, 4000)
              return { ok: true, text: clicked ? '已开启新对话' : '未找到新对话按钮', error: '' }
            } finally {
              cdp.close()
            }
          }
          if (action === 'ask') {
            if (!args || !args.text || !String(args.text).trim()) return { ok: false, text: '', error: 'ask 操作需要 text 参数' }
            if (!(await withTimeout(ensureCdp(doubaoExe, exec.signal), 120000, exec.signal))) return { ok: false, text: '', error: '桌面豆包不可用' }
            const text = await withLock(() => doubaoAsk({ prompt: String(args.text).trim(), timeoutMs: 120000, signal: exec.signal }))
            return { ok: true, text, error: '' }
          }
          return { ok: false, text: '', error: '未知操作: ' + action + '(可用 status/restart/new-chat/ask)' }
        } catch (e) {
          return { ok: false, text: '', error: (e && e.message) || String(e) }
        }
      },
    })
    } catch (e) {
      // Never let this row fail boot: an API drift in a newer DSH version
      // degrades the plugin to a logged no-op instead of blocking startup.
      logLine('apply failed (DSH API change?): ' + String((e && e.stack) || e))
    }
  },
}
