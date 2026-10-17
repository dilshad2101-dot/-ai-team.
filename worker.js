/** Cloudflare Worker: six-stage analysis with text, image, and short screen-recording input.
 * Add GEMINI_API_KEY as a Worker Secret. Never paste the key into this source file.
 */
const GEMINI_MODEL = "gemini-3.8-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_FILES = 5;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const ALLOWED_TEXT = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_VIDEO = new Set(["video/webm", "video/mp4"]);
const STAGE_TITLES = [
  "المرحلة 1: فهم المهمة وتحليل المرفقات",
  "المرحلة 2: اقتراح حلول متعددة",
  "المرحلة 3: النقد المتبادل واكتشاف الأخطاء",
  "المرحلة 4: التحقق من الحقائق والأدلة",
  "المرحلة 5: مقارنة الحلول والتحكيم",
  "المرحلة 6: الإجابة النهائية وخطة العمل"
];
const STAGE_INSTRUCTIONS = [
  "افهم المطلوب بدقة. افحص جميع المرفقات التي أُرسلت إليك: لخّص محتوى الصور والفيديو، وصف ما يظهر في التسجيل بتسلسل زمني، واقرأ النصوص المرفقة. لا تستنتج ما لا يظهر بوضوح. اذكر الحقائق والمجهولات والأسئلة الضرورية. لا تعطِ الحكم النهائي بعد.",
  "اعتمادًا على المهمة وملخص المرحلة الأولى، اقترح ثلاثة حلول أو مسارات مختلفة قدر الإمكان. لكل حل اذكر فائدته ومتطلباته وحدوده. لا تكرر الحل نفسه بصيغ مختلفة.",
  "انتقد الحلول المقترحة بصرامة. ابحث عن الافتراضات غير المدعومة والتناقضات والثغرات والمخاطر. صحح ما أمكن، واحتفظ بالخلاف الحقيقي بدل الاتفاق المصطنع.",
  "راجع الادعاءات المهمة. ميّز بين ما تدعمه المرفقات أو المعرفة المتاحة وما يحتاج إلى مصدر خارجي. لا تدّع أنك بحثت الإنترنت إذا لم تتوفر أداة بحث، ولا تخترع مراجع أو أرقامًا. وضّح أي معلومة لا يمكن التحقق منها.",
  "قارن الحلول بمعايير مناسبة للمهمة: الملاءمة، قوة الدليل، الدقة، سهولة التنفيذ، التكلفة، السلامة والمخاطر. أعطِ درجات تقريبية فقط إذا كان ذلك مفيدًا، وبيّن سبب كل درجة وحدود التقييم.",
  "اكتب إجابة نهائية مباشرة بالعربية، مبنية على المراحل السابقة. اذكر الحل الموصى به وأسباب اختياره والخطوات العملية التالية. افصل بوضوح بين المؤكد والمحتمل وما يحتاج إلى تحقق. إذا كان التسجيل أو الملف غير واضح أو تعذر تحليل جزء منه، فصرّح بذلك."
];
function cors(origin) {
  const allowedOrigin = "https://dilshad2101-dot.github.io";
  return {
    "Access-Control-Allow-Origin": origin === allowedOrigin ? allowedOrigin : allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}
function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors(origin) } });
}
function byteLengthBase64(s) { return Math.floor(String(s || "").length * 3 / 4); }
function textBytes(s) { return new TextEncoder().encode(String(s || "")).length; }
function normaliseFile(file, index) {
  if (!file || typeof file !== "object") throw new Error(`المرفق رقم ${index + 1} غير صالح.`);
  const name = String(file.name || `file-${index + 1}`).slice(0, 180);
  const mimeType = String(file.mimeType || file.type || "application/octet-stream").toLowerCase();
  if (ALLOWED_IMAGE.has(mimeType)) {
    const data = String(file.data || "").replace(/^data:[^,]+,/, "");
    if (!data || byteLengthBase64(data) > MAX_TEXT_BYTES) throw new Error(`الصورة ${name} فارغة أو أكبر من 4 ميغابايت.`);
    return { name, mimeType, data };
  }
  if (ALLOWED_VIDEO.has(mimeType)) {
    const data = String(file.data || "").replace(/^data:[^,]+,/, "");
    if (!data || byteLengthBase64(data) > MAX_VIDEO_BYTES) throw new Error(`الفيديو ${name} فارغ أو أكبر من 10 ميغابايت. سجّل مدة أقصر.`);
    return { name, mimeType, data };
  }
  if (ALLOWED_TEXT.has(mimeType)) {
    const text = String(file.text || "");
    if (textBytes(text) > MAX_TEXT_BYTES) throw new Error(`الملف النصي ${name} أكبر من 4 ميغابايت.`);
    return { name, mimeType, text };
  }
  throw new Error(`نوع المرفق غير مدعوم: ${name} (${mimeType}).`);
}
function makeParts(prompt, files, stageIndex, prior) {
  const parts = [];
  if (stageIndex === 0) {
    parts.push({ text: `المهمة التي أرسلها المستخدم:\n${prompt || "حلل المرفقات المرفوعة وحدها، واذكر إن لم يتضح الهدف."}\n\nالمرفقات المرفقة في هذه الرسالة جزء من المهمة، افحصها مباشرة ولا تكتفِ بتخمين محتواها.` });
    for (const f of files) {
      if (f.text !== undefined) parts.push({ text: `\n--- محتوى الملف: ${f.name} (${f.mimeType}) ---\n${f.text}\n--- نهاية الملف ---` });
      else parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
    }
  } else {
    parts.push({ text: `مهمة المستخدم:\n${prompt || "حلل المرفقات"}\n\nنتائج المراحل السابقة:\n${prior}` });
  }
  parts.push({ text: `\n\nأنت الآن تنفذ ${STAGE_TITLES[stageIndex]}. ${STAGE_INSTRUCTIONS[stageIndex]}\nأخرج نتيجة هذه المرحلة فقط، بعناوين واضحة، ولا تزعم أن لديك أدوات أو مصادر لم تستخدمها.` });
  return parts;
}
async function callGemini(env, parts) {
  if (!env.GEMINI_API_KEY) throw new Error("سر GEMINI_API_KEY غير مضبوط في إعدادات Cloudflare Worker.");
  const url = `${API_BASE}${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0.25, maxOutputTokens: 4096 } })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Gemini API returned HTTP ${response.status}`;
    const err = new Error(message); err.status = response.status; err.details = message; throw err;
  }
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
  if (!text) throw new Error("لم يُرجع Gemini نصًا. قد يكون الفيديو غير مدعوم في النموذج الحالي أو قد تكون الاستجابة محجوبة.");
  return text;
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method === "GET") return json({ ok: true, service: "ai-team-api", message: "Worker supports six-stage analysis and text/image/short-video attachments" }, 200, origin);
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, origin);
    try {
      const body = await request.json();
      const prompt = String(body.prompt || "").trim().slice(0, 30000);
      const rawFiles = Array.isArray(body.files) ? body.files : [];
      if (rawFiles.length > MAX_FILES) return json({ ok: false, error: "الحد الأقصى خمسة مرفقات." }, 400, origin);
      if (!prompt && rawFiles.length === 0) return json({ ok: false, error: "اكتب المهمة أو أرفق ملفًا." }, 400, origin);
      const files = rawFiles.map(normaliseFile);
      const stages = [];
      let prior = "";
      for (let i = 0; i < STAGE_TITLES.length; i++) {
        const stageText = await callGemini(env, makeParts(prompt, files, i, prior));
        stages.push({ title: STAGE_TITLES[i], text: stageText });
        prior += `\n\n${STAGE_TITLES[i]}\n${stageText}`;
        if (prior.length > 60000) prior = prior.slice(-60000);
      }
      const finalText = stages[5].text;
      return json({ ok: true, text: finalText, stages, files: files.map(f => ({ name: f.name, mimeType: f.mimeType })) }, 200, origin);
    } catch (error) {
      const message = error?.message || "حدث خطأ غير معروف.";
      const status = error?.status || 500;
      return json({ ok: false, error: message, details: error?.details || "تحقق من إعدادات النموذج والحصة وحجم المرفقات.", status }, status >= 400 && status < 600 ? status : 500, origin);
    }
  }
};
