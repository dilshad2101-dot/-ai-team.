/**
 * فريق العمل الذكي — Cloudflare Worker
 * يدعم وضع الإجابة السريعة (طلب واحد) ووضع فريق العمل (ست مراحل).
 * اضبط GEMINI_API_KEY كـ Worker Secret في Cloudflare، ولا تضعه داخل هذا الملف.
 */
const GEMINI_MODEL = "gemini-3.8-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const ALLOWED_ORIGIN = "https://dilshad2101-dot.github.io";
const MAX_FILES = 5;
const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 12 * 1024 * 1024;
const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_PROMPT_CHARS = 30000;
const MAX_PRIOR_CHARS = 14000;

const ALLOWED_TEXT = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);
const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/webp"]);
const ALLOWED_VIDEO = new Set(["video/webm", "video/mp4"]);

const STAGE_TITLES = [
  "1. فهم المهمة وتحديد المطلوب",
  "2. اقتراح حلول مناسبة",
  "3. النقد واكتشاف الأخطاء",
  "4. التحقق من الحقائق والأدلة",
  "5. مقارنة الحلول ومراجعتها",
  "6. الإجابة النهائية"
];

const STAGE_INSTRUCTIONS = [
  "افهم طلب المستخدم كما كُتب حرفيًا. حدّد الهدف والقيود والحقائق المذكورة وما ينقص. افحص المرفقات المرسلة مباشرة. أخرج ملخصًا عمليًا موجزًا لا يتجاوز 120 كلمة، ولا تجب عن مهمة مختلفة.",
  "استخدم طلب المستخدم وملخص المرحلة الأولى. اقترح ما يصل إلى ثلاثة مسارات مختلفة عند الحاجة، مع فائدة وحدّ أساسي لكل مسار. إن كانت المهمة سؤالًا بسيطًا لا يحتاج حلولًا متعددة، فقل ذلك باختصار. حد أقصى 150 كلمة.",
  "راجع المقترحات بحثًا عن أخطاء أو افتراضات غير مثبتة أو تناقضات أو مخاطر. لا تختلق خلافًا أو ملاحظات شكلية. اذكر فقط ما يؤثر في صحة النتيجة. حد أقصى 150 كلمة.",
  "تحقق من الادعاءات المهمة باستخدام البحث على الويب المتاح في هذه المرحلة. استشهد بالمصادر التي يعرضها البحث، وميّز بين المؤكد وغير المؤكد. لا تدّع التحقق من معلومة إذا لم يتوفر لها دليل، ولا تخترع روابط أو مراجع. حد أقصى 180 كلمة.",
  "قارن الخيارات حسب ملاءمتها ودقتها وسهولة تطبيقها وتكلفتها ومخاطرها. عند السؤال البسيط، اكتفِ بفحص مختصر بدل إنشاء جدول طويل. حد أقصى 120 كلمة.",
  "اكتب الجواب النهائي للمستخدم مباشرة وبالعربية. لا تعِد طباعة تقارير المراحل السابقة، ولا تكرر الإجابة، ولا تضع قسمًا ثانيًا بعنوان النتيجة النهائية. أجب عن المهمة الحالية نفسها. اجعل الإجابة بطول يناسب صعوبة السؤال، واذكر المصادر المتاحة عند وجودها."
];

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  // GitHub Pages origin for the public site. Calls without Origin are allowed for health checks.
  if (origin === ALLOWED_ORIGIN || !origin) headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  return headers;
}

function json(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) }
  });
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

function base64Bytes(value) {
  const clean = String(value || "").replace(/\s/g, "");
  if (!clean) return 0;
  return Math.max(0, Math.floor(clean.length * 3 / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0));
}

function normaliseFile(file, index) {
  if (!file || typeof file !== "object") throw new Error(`المرفق رقم ${index + 1} غير صالح.`);
  const name = String(file.name || `file-${index + 1}`).slice(0, 180);
  const rawMime = String(file.mimeType || file.type || "application/octet-stream").toLowerCase();
  const mimeType = rawMime.split(";")[0].trim();

  if (ALLOWED_IMAGE.has(mimeType)) {
    const data = String(file.data || "").replace(/^data:[^,]+,/, "").replace(/\s/g, "");
    const bytes = base64Bytes(data);
    if (!bytes) throw new Error(`الصورة ${name} فارغة أو غير قابلة للقراءة.`);
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`الصورة ${name} أكبر من 4 ميغابايت.`);
    return { name, mimeType, data, bytes, kind: "binary" };
  }

  if (ALLOWED_VIDEO.has(mimeType)) {
    const data = String(file.data || "").replace(/^data:[^,]+,/, "").replace(/\s/g, "");
    const bytes = base64Bytes(data);
    if (!bytes) throw new Error(`الفيديو ${name} فارغ أو غير قابل للقراءة.`);
    if (bytes > MAX_VIDEO_BYTES) throw new Error(`الفيديو ${name} أكبر من 10 ميغابايت. جرّب تسجيل مدة أقصر.`);
    return { name, mimeType, data, bytes, kind: "video" };
  }

  if (ALLOWED_TEXT.has(mimeType)) {
    const text = String(file.text || "");
    const bytes = utf8Bytes(text);
    if (bytes > MAX_TEXT_FILE_BYTES) throw new Error(`الملف النصي ${name} أكبر من 4 ميغابايت.`);
    return { name, mimeType, text, bytes, kind: "text" };
  }

  throw new Error(`نوع الملف غير مدعوم: ${name} (${mimeType}). استخدم صورة PNG/JPG/WebP أو فيديو MP4/WebM أو TXT/MD/CSV/JSON.`);
}

function makeInitialParts(prompt, files) {
  const parts = [{ text: `طلب المستخدم الحالي (لا تستبدله بسؤال سابق):\n${prompt || "حلل المرفقات المرفوعة واذكر ما يمكن استخلاصه منها."}` }];
  for (const file of files) {
    if (file.kind === "text") {
      parts.push({ text: `\n\n--- بداية الملف: ${file.name} (${file.mimeType}) ---\n${file.text}\n--- نهاية الملف ---` });
    } else {
      parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
      parts.push({ text: `المرفق السابق هو ${file.kind === "video" ? "فيديو/تسجيل شاشة" : "صورة"} باسم ${file.name}. حلله فقط بقدر ما تسمح به محتوياته.` });
    }
  }
  return parts;
}

function stageParts(prompt, files, stageIndex, prior) {
  const parts = stageIndex === 0
    ? makeInitialParts(prompt, files)
    : [{ text: `طلب المستخدم الحالي (أجب عنه نفسه دون استبداله):\n${prompt || "حلل المرفقات المرفوعة."}\n\nملخص المراحل السابقة:\n${prior}` }];
  parts.push({ text: `\n\nأنت تنفذ الآن ${STAGE_TITLES[stageIndex]}. ${STAGE_INSTRUCTIONS[stageIndex]}\nاكتب نتيجة هذه المرحلة فقط. لا تكرر عناوين أو نصوص المراحل السابقة.` });
  return parts;
}

async function callGemini(env, parts, options = {}) {
  if (!env.GEMINI_API_KEY) {
    const error = new Error("مفتاح Gemini غير مضبوط. تحقق من وجود GEMINI_API_KEY في Worker Secrets على Cloudflare.");
    error.status = 500;
    throw error;
  }

  const payload = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxOutputTokens ?? 1200
    }
  };
  if (options.googleSearch) payload.tools = [{ google_search: {} }];

  const url = `${API_BASE}${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    let message = data?.error?.message || `Gemini API أعاد HTTP ${response.status}.`;
    if (response.status === 429) message = `تجاوزت حصة Gemini أو معدل الطلبات المسموح مؤقتًا. انتظر حتى تتجدد الحصة أو راجع خطة API. التفاصيل: ${message}`;
    const error = new Error(message);
    error.status = response.status >= 400 && response.status <= 599 ? response.status : 502;
    throw error;
  }

  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map(part => part.text || "").join("\n").trim();
  if (!text) {
    const error = new Error("لم يُرجع Gemini نصًا. قد تكون الاستجابة محجوبة أو تعذر تحليل أحد المرفقات.");
    error.status = 502;
    throw error;
  }

  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const sources = chunks.map(chunk => ({
    title: String(chunk?.web?.title || "مصدر ويب").slice(0, 300),
    url: String(chunk?.web?.uri || "")
  })).filter(source => /^https?:\/\//i.test(source.url));
  return { text, sources };
}

function uniqueSources(allSources) {
  const seen = new Set();
  return allSources.filter(source => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  }).slice(0, 12);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ ok: false, error: "هذا النطاق غير مصرح له باستخدام الخدمة." }, 403, "");
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method === "GET") {
      return json({
        ok: true,
        service: "ai-team-api",
        model: GEMINI_MODEL,
        modes: ["quick", "team"],
        message: "الخدمة جاهزة. وضع quick لطلب واحد سريع، ووضع team لست مراحل متتابعة. الملفات النصية والصور والفيديو القصير مدعومة."
      }, 200, origin);
    }
    if (request.method !== "POST") return json({ ok: false, error: "الطريقة غير مدعومة." }, 405, origin);

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return json({ ok: false, error: "حجم الطلب كبير جدًا. قلّل حجم المرفقات أو أرسل الفيديو وحده.", maxRequestMiB: 18 }, 413, origin);
    }

    try {
      const body = await request.json();
      const prompt = String(body.prompt || "").trim().slice(0, MAX_PROMPT_CHARS);
      const mode = body.mode === "team" ? "team" : "quick";
      const rawFiles = Array.isArray(body.files) ? body.files : [];
      if (rawFiles.length > MAX_FILES) return json({ ok: false, error: "الحد الأقصى خمسة مرفقات." }, 400, origin);
      if (!prompt && rawFiles.length === 0) return json({ ok: false, error: "اكتب السؤال أو أرفق ملفًا." }, 400, origin);

      const files = rawFiles.map(normaliseFile);
      let totalBytes = 0;
      let videoCount = 0;
      for (const file of files) {
        totalBytes += file.bytes;
        if (file.kind === "video") videoCount++;
      }
      if (videoCount > 1) return json({ ok: false, error: "أرفق فيديو واحدًا فقط في كل طلب حتى يمكن تحليله بثبات." }, 400, origin);
      if (totalBytes > MAX_TOTAL_FILE_BYTES) {
        return json({ ok: false, error: "إجمالي المرفقات يتجاوز 12 ميغابايت. احذف بعض المرفقات أو أرسل الفيديو وحده.", maxTotalMiB: 12 }, 413, origin);
      }

      const fileInfo = files.map(file => ({ name: file.name, mimeType: file.mimeType, sizeBytes: file.bytes }));
      const initialParts = makeInitialParts(prompt, files);

      if (mode === "quick") {
        const quickPrompt = {
          text: "أجب عن طلب المستخدم الحالي بأقصر إجابة مفيدة ودقيقة. لا تنشئ مراحل أو تقارير داخلية. ابدأ بالإجابة مباشرة؛ إن كان السؤال بسيطًا فأجب بجملة أو جملتين فقط. إذا كانت المعلومة غير مؤكدة فقل ذلك، ولا تخترع مصادر أو تدّعي أنك بحثت في الويب."
        };
        const result = await callGemini(env, [...initialParts, quickPrompt], { maxOutputTokens: 1000, temperature: 0.2 });
        return json({ ok: true, mode, text: result.text, stages: [], sources: result.sources, files: fileInfo }, 200, origin);
      }

      const stages = [];
      const allSources = [];
      let prior = "";
      for (let i = 0; i < STAGE_TITLES.length; i++) {
        const options = {
          maxOutputTokens: i === 5 ? 1300 : 520,
          temperature: 0.2,
          googleSearch: i === 3
        };
        const result = await callGemini(env, stageParts(prompt, files, i, prior), options);
        const stage = { title: STAGE_TITLES[i], text: result.text };
        stages.push(stage);
        if (i === 3) allSources.push(...result.sources);
        prior += `\n\n${stage.title}\n${result.text}`;
        if (prior.length > MAX_PRIOR_CHARS) prior = prior.slice(-MAX_PRIOR_CHARS);
      }

      // Display final stage once as the main answer; the page shows only stages 1–5 as optional details.
      return json({
        ok: true,
        mode,
        text: stages[5].text,
        stages,
        sources: uniqueSources(allSources),
        files: fileInfo
      }, 200, origin);
    } catch (error) {
      const message = error?.message || "حدث خطأ غير معروف.";
      const status = Number(error?.status || 500);
      return json({
        ok: false,
        error: message,
        status: status >= 400 && status <= 599 ? status : 500
      }, status >= 400 && status <= 599 ? status : 500, origin);
    }
  }
};
