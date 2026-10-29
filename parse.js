// פונקציות חילוץ טהורות (כתובת, מחיר, שטח). נטענות לפני content.js ואפשר לבדוק אותן ב-Node.
var LR = (() => {
  const HEB = /[֐-׿]/;

  // מילים שמתארות סוג נכס ולא מקום
  const TYPE_WORDS =
    /^(דירה|דירת גן|דירת גג|גג\/פנטהאוז|פנטהאוז|דופלקס|טריפלקס|בית פרטי|בית|וילה|קוטג'?|מגרש|יחידת דיור|סטודיו|לופט|משק|נחלה|דירת סטודיו|דו משפחתי|חד משפחתי|בניין|מבנה)(\s|$)/;

  // שורות שהן לא כתובת
  const NOISE_LINE =
    /₪|^\d+(\.\d+)?$|חדרים|חד['׳]|מ["״”'׳]ר|קומה|קומות|^חדש( מהקבלן)?$|ממתין|מתווך|תיווך|^פרטי$|קבלן|כניסה|עודכן|^לפני |פרסם|מבצע|ללא עמלה|מציג|מחיר|טלפון|שמור|מועדפים/;

  const clean = (s) => s.replace(/\s+/g, " ").trim();
  const toNum = (s) => Number(String(s).replace(/[^\d.]/g, ""));

  function normStreet(s) {
    return s
      .replace(/^(רחוב|רח'|רח׳)\s+/, "")
      .replace(/^שד['׳]\s*/, "שדרות ")
      .trim();
  }

  // מחזיר רשימת שאילתות גיאוקוד לפי סדר עדיפות: [{ q, approx, bias }]
  //  approx = ההערכה גסה (שכונה/עיר/רחוב בלי עיר)
  //  bias   = לתת עדיפות לאזור שבו כבר נמצאו מודעות אחרות בדף
  function parseAddress(text, ctxCity) {
    const lines = String(text || "")
      .split("\n")
      .map(clean)
      .filter((s) => s && s.length < 90 && HEB.test(s) && !NOISE_LINE.test(s));

    let street = null;
    const locs = []; // שכונה / עיר, לפי סדר הופעה

    for (const line of lines) {
      if (line.includes(",")) {
        const parts = line
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p && !TYPE_WORDS.test(p));
        if (!parts.length) continue;
        const di = parts.findIndex((p) => /\d/.test(p));
        if (di >= 0 && !street) {
          street = parts[di];
          parts.splice(di, 1);
        }
        for (const p of parts) if (!locs.includes(p)) locs.push(p);
      } else if (!street && /\d/.test(line) && line.length >= 4 && !TYPE_WORDS.test(line)) {
        street = line;
      }
    }

    const city = locs.length ? locs[locs.length - 1] : null;
    const hood = locs.length > 1 ? locs[0] : null;
    const ctx = ctxCity || null;

    const queries = [];
    const add = (q, approx = false, bias = false) => {
      if (q && !queries.some((x) => x.q === q)) queries.push({ q, approx, bias });
    };

    const st = street ? normStreet(street) : null;
    if (st) {
      // אם המשתמש סינן לפי עיר (מהכתובת של הדף), כל המודעות בה – זה הניסיון הראשון
      if (ctx) add(`${st}, ${ctx}`);
      if (city && city !== ctx) add(`${st}, ${city}`);
      if (hood && hood !== city && hood !== ctx) add(`${st}, ${hood}`);
      add(st, true, true); // רחוב בלי עיר (עם הטיה לאזור הדף)
    }
    if (hood && (ctx || city)) add(`${hood}, ${ctx || city}`, true);
    if (!st && !hood) {
      const c = city || ctx;
      if (c) add(c, true);
    }

    return { queries: queries.slice(0, 5), street: st, city, hood };
  }

  // מחיר, שטח, ומחיר למ"ר. תמיד מחזיר אובייקט; ppsm הוא null אם אי אפשר לחשב.
  function extractPriceSqm(text) {
    text = String(text || "");

    let price = null;
    const pm = text.match(/₪\s*([\d,]{5,})/) || text.match(/([\d,]{5,})\s*₪/);
    if (pm) price = toNum(pm[1]);
    if (!price) {
      const mm = text.match(/(\d+(?:\.\d+)?)\s*(?:מיליון|M\b)/);
      if (mm) price = Math.round(toNum(mm[1]) * 1e6);
    }
    if (!price) {
      // גיבוי: מספר גדול עם פסיקים, גם בלי סימן ₪
      const nums = [...text.matchAll(/\b\d{1,3}(?:,\d{3})+\b/g)]
        .map((m) => toNum(m[0]))
        .filter((n) => n >= 100000);
      if (nums.length) price = nums[0];
    }

    let sqm = null;
    const sm = text.match(/(\d{2,4}(?:\.\d+)?)\s*מ["״”'׳]?ר(?![א-ת])/);
    if (sm) sqm = toNum(sm[1]);
    if (sqm && (sqm < 15 || sqm > 1000)) sqm = null;

    let reason = null;
    if (!price && !sqm) reason = "לא זוהו מחיר ושטח";
    else if (!price) reason = "לא זוהה מחיר";
    else if (!sqm) reason = "לא זוהה שטח (מ״ר)";
    else if (price < 100000) reason = "נראה כמחיר שכירות";

    const ppsm = !reason ? Math.round(price / sqm) : null;
    return { price, sqm, ppsm, reason };
  }

  return { parseAddress, extractPriceSqm };
})();

if (typeof module !== "undefined") module.exports = LR;
