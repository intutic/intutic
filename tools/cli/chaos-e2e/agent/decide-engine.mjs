// A scripted decide engine for the chaos e2e suite: an OpenAI-compatible
// chat completion of one token with top_logprobs, the `logprobs` adapter's
// wire format (Ollama, vLLM, llama.cpp). No model runs.
//
// It answers the client's known-answer canary correctly (the recursive delete
// from the root reads as yes, `ls -la` as no, the choice picks delete_files),
// and every other yes/no question with p(yes) = `pYes`, so an experiment picks
// the band its rule lands in: above yes_at refuses, below no_below allows,
// between them escalates.
//
// Each request is appended to `logFile` as one JSON line: which question, and
// the p(yes) or label it answered with.
import fs from 'node:fs'
import { createServer } from 'node:http'

const CANARY_YES_NO = 'QUESTION: Does this command delete files recursively from the root of the filesystem?'
const CANARY_CHOICE = 'QUESTION: What does this command do?'
const CANARY_VIOLATION = '"command":"rm -rf / --no-preserve-root"'

/** One token's top_logprobs, as a chat completion carries them. */
function completion(top) {
  const tokens = Object.entries(top).map(([token, p]) => ({ token, logprob: Math.log(p) }))
  return { choices: [{ index: 0, message: { role: 'assistant', content: tokens[0].token }, logprobs: { content: [{ ...tokens[0], top_logprobs: tokens }] } }] }
}

/** The labels a choice prompt lists, `A) delete_files` and so on, as option → label. */
function choiceLabels(prompt) {
  return Object.fromEntries([...prompt.matchAll(/^([A-T])\) ([a-z0-9_]+)$/gm)].map((m) => [m[2], m[1]]))
}

/** Starts the engine on a loopback port. Resolves with its URL and a close function. */
export async function startDecideEngine({ pYes, logFile }) {
  const log = (entry) => {
    if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + '\n')
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: 'not found' })
      let prompt = ''
      try {
        prompt = String(JSON.parse(raw).messages?.[0]?.content ?? '')
      } catch {
        return send(400, { error: 'body is not JSON' })
      }
      if (prompt.includes(CANARY_CHOICE)) {
        const labels = choiceLabels(prompt)
        const top = { [labels.delete_files]: 0.97 }
        for (const [option, label] of Object.entries(labels)) if (option !== 'delete_files') top[label] = 0.01
        log({ question: 'canary choice', answer: labels.delete_files })
        return send(200, completion(top))
      }
      const canary = prompt.includes(CANARY_YES_NO)
      const p = canary ? (prompt.includes(CANARY_VIOLATION) ? 0.99 : 0.01) : pYes
      log({ question: canary ? 'canary yes/no' : (/\nQUESTION: (.*)\n/.exec(prompt)?.[1] ?? '?'), pYes: p })
      // The more likely token first: the client needs the top token to be a label.
      return send(200, completion(p >= 0.5 ? { yes: p, no: 1 - p } : { no: 1 - p, yes: p }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** A loopback port nothing listens on: bound, then released. A stopped engine. */
export async function closedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(() => resolve()))
  return port
}
