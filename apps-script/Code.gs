/**
 * AIYK bidirectional translator for Google Apps Script.
 *
 * GET examples:
 *   ?q=Hello&source=en&target=ko
 *   ?q=안녕하세요&source=ko&target=en
 *   ?q=안녕하세요  // Korean is detected and translated to English
 *
 * POST JSON example:
 *   {"q":"안녕하세요","source":"ko","target":"en"}
 */
function doGet(e) {
  return handleTranslation_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  var params = {};
  try {
    if (e && e.postData && e.postData.contents) {
      params = JSON.parse(e.postData.contents);
    }
  } catch (error) {
    return textOutput_('ERROR: 올바른 JSON 요청이 아닙니다.');
  }
  return handleTranslation_(params);
}

function handleTranslation_(params) {
  try {
    var text = String(params.q || params.text || '').trim();
    if (!text) return textOutput_('ERROR: q 또는 text 값이 필요합니다.');
    if (text.length > 5000) return textOutput_('ERROR: 한 번에 5000자까지 번역할 수 있습니다.');

    var detectedSource = containsKorean_(text) ? 'ko' : 'en';
    var source = normalizeLanguage_(params.source || detectedSource);
    var target = normalizeLanguage_(params.target || (source === 'ko' ? 'en' : 'ko'));
    if (source === target) return textOutput_(text);

    var cache = CacheService.getScriptCache();
    var cacheKey = makeCacheKey_(source + ':' + target + ':' + text);
    var cached = cache.get(cacheKey);
    if (cached !== null) return textOutput_(cached);

    var translated = LanguageApp.translate(text, source, target);
    cache.put(cacheKey, translated, 21600); // 6 hours
    return textOutput_(translated);
  } catch (error) {
    console.error(error);
    return textOutput_('ERROR: 번역 중 오류가 발생했습니다.');
  }
}

function containsKorean_(text) {
  return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text);
}

function normalizeLanguage_(language) {
  var value = String(language || '').toLowerCase().trim();
  if (value === 'kr') value = 'ko';
  if (value !== 'ko' && value !== 'en') {
    throw new Error('지원 언어는 ko와 en입니다.');
  }
  return value;
}

function makeCacheKey_(value) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );
  return 'aiyk_' + Utilities.base64EncodeWebSafe(digest).slice(0, 120);
}

function textOutput_(text) {
  return ContentService
    .createTextOutput(String(text))
    .setMimeType(ContentService.MimeType.TEXT);
}
