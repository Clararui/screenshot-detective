// Vercel serverless function: POST /api/check  { text?, image? (data URL) }  →  { answer }
// Talks to the published Dify web app (the same one the embed iframe uses).
// The app code is public (it is in the embed snippet), so no secret is needed.
//
// Optional environment variables:
//   DIFY_APP_CODE   default oPgGtTDWaz0Zim9t
//   DIFY_WEB_API    default https://udify.app/api

const CODE = process.env.DIFY_APP_CODE || 'oPgGtTDWaz0Zim9t';
const API = (process.env.DIFY_WEB_API || 'https://udify.app/api').replace(/\/$/, '');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: '只支持 POST' });
  try {
    const { text = '', image } = req.body || {};
    if (!String(text).trim() && !image) return res.status(400).json({ error: '请提供文字或截图' });

    // 1. Get a visitor passport for the web app
    const p = await fetch(`${API}/passport`, { headers: { 'X-App-Code': CODE } });
    if (!p.ok) throw new Error('Dify 登录凭证获取失败：' + p.status);
    const { access_token } = await p.json();
    const auth = { 'X-App-Code': CODE, 'X-App-Passport': access_token };

    // 2. Upload the screenshot, if any
    let files = [];
    if (image) {
      const m = /^data:(image\/[\w+.-]+);base64,(.+)$/.exec(image);
      if (!m) return res.status(400).json({ error: '图片格式不正确' });
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), `screenshot.${ext}`);
      const up = await fetch(`${API}/files/upload`, { method: 'POST', headers: auth, body: form });
      const uj = await up.json().catch(() => ({}));
      if (!up.ok) throw new Error('截图上传失败：' + (uj.message || up.status));
      files = [{ type: 'image', transfer_method: 'local_file', upload_file_id: uj.id, url: '' }];
    }

    // 3. Run the chatflow and collect the streamed answer
    const r = await fetch(`${API}/chat-messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {},
        query: String(text).trim() || '请核查这张截图',
        response_mode: 'streaming',
        conversation_id: '',
        files,
      }),
    });
    if (!r.ok) throw new Error('Dify 调用失败：' + r.status);
    const raw = await r.text();
    let answer = '', error = '';
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let e; try { e = JSON.parse(line.slice(5)); } catch { continue; }
      if (e.event === 'message' || e.event === 'agent_message') answer += e.answer || '';
      if (e.event === 'message_replace') answer = e.answer || '';
      if (e.event === 'error') error = e.message || 'Dify 流程出错';
    }
    if (!answer && error) throw new Error(error);
    if (!answer) throw new Error('Dify 没有返回内容');
    return res.status(200).json({ answer });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: e.message || '查证服务暂时不可用' });
  }
}
