// Facebook-specific post classification; depends on parse.js for price and area extraction.
(() => {
  const root = globalThis;
  const parser = root.LR;
  if (!parser || typeof parser.extractPriceSqmFree !== "function") {
    throw new Error("facebook-classifier.js requires parse.js to load first.");
  }

  const normalizeQuotes = (value) =>
    String(value || "")
      .replace(/[״“”]/g, '"')
      .replace(/[׳‘’]/g, "'");

  function classifyFacebookPost(text) {
    const source = normalizeQuotes(text);
    const seekingMatch =
      /מחפש(?:ת|ים|ות)?\s+(?:(?:.{1,35}?)\s+)?(?:דירה|דירות|נכס|נכסים|בית|בתים|יחיד(?:ה|ת)(?:\s+דיור)?|קרקע|מגרש|חדרים?|לשכור|לקנות|לרכוש|שותף|שותפים)/.exec(
        source
      );
    const seekingIndex = seekingMatch ? seekingMatch.index : -1;
    const saleMatch =
      /למכירה|למכור|מוכר(?:ת)?\s+(?:דירה|נכס|בית)|מכירה\s+(?:ישירה|מפרטי|פרטית)/.exec(
        source
      );
    const saleIndex = saleMatch ? saleMatch.index : -1;
    const rentMatch =
      /להשכרה|לשכירות|השכרה|שכר\s*דירה|שכ"ד|דמי\s*שכירות|לחודש|\/\s*חודש|בחודש|סאבלט/.exec(
        source
      );
    const rentIndex = rentMatch ? rentMatch.index : -1;
    const property =
      /דירה|דירת|חדרים|חד'|פנטהאוז|דופלקס|טריפלקס|מ"ר|מ'ר|\bמר\b|נכס|קוטג|בית\b|וילה|מגרש/.test(
        source
      );
    const sellerLanguage =
      /תיאום\s+(?:ביקור|סיור)|חייגו|התקשרו|שלחו\s+הודעה|צרו\s+קשר|בואו\s+להתרשם|מחכה\s+לכם/.test(
        source
      );
    const parsed = parser.extractPriceSqmFree(source);
    const hasListingDetails =
      Boolean(parsed.price || parsed.sqm) ||
      /\d(?:[.,]\d)?\s*(?:חדרים?|חד['׳]?)/.test(source);
    const explicitlyForSale = saleIndex >= 0;
    const saleListing =
      explicitlyForSale &&
      property &&
      hasListingDetails &&
      (seekingIndex < 0 || sellerLanguage || saleIndex < seekingIndex) &&
      (rentIndex < 0 || saleIndex < rentIndex);

    if (saleListing) return { type: "listing", parsed };

    if (seekingIndex >= 0 && (rentIndex < 0 || seekingIndex < rentIndex)) {
      if (!sellerLanguage) return { type: "seeking" };
    }

    if (rentIndex >= 0 && (saleIndex < 0 || rentIndex < saleIndex)) {
      return { type: "rent" };
    }

    const lowPrice = [...source.matchAll(
      /(?:₪\s*([\d,]{3,})|([\d,]{3,})\s*(?:₪|ש["״]?ח|שקל(?:ים)?))/g
    )]
      .map((match) => Number((match[1] || match[2]).replace(/,/g, "")))
      .some((price) => price >= 800 && price <= 40000);
    if (lowPrice && !explicitlyForSale) return { type: "rent" };

    if (seekingIndex >= 0 && !sellerLanguage) return { type: "seeking" };

    if (property && hasListingDetails) return { type: "listing", parsed };
    return { type: "other" };
  }

  parser.classifyFacebookPost = classifyFacebookPost;
  if (typeof module !== "undefined") module.exports = classifyFacebookPost;
})();
