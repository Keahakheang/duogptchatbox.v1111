import { chromium } from "playwright";

const BASE_URL = "https://www.fairprice.com.sg";
const MAX_PRODUCTS = 4;

let browserPromise;
let busy = false;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((error) => {
      browserPromise = undefined;
      throw error;
    });
  }

  return browserPromise;
}

function getProductUrl(value) {
  try {
    const url = new URL(value, BASE_URL);

    if (
      url.origin !== BASE_URL ||
      !url.pathname.startsWith("/product/")
    ) {
      return null;
    }

    url.search = "";
    url.hash = "";

    return url.href;
  } catch {
    return null;
  }
}

function collectProducts(value, results = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProducts(item, results);
    }

    return results;
  }

  if (!value || typeof value !== "object") {
    return results;
  }

  const types = [value["@type"]].flat();

  if (types.some((type) => type === "Product")) {
    results.push(value);
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectProducts(child, results);
    }
  }

  return results;
}

function getVerifiedOffer(product, pageUrl) {
  if (typeof product.name !== "string" || !product.name.trim()) {
    return null;
  }

  // Do not substitute AggregateOffer.lowPrice: it may describe a range
  // or a different seller/variant rather than this product's actual price.
  const offers = [product.offers ?? []].flat();

  const validOffers = offers.filter((offer) => {
    if (!offer || typeof offer !== "object") {
      return false;
    }

    const types = [offer["@type"]].flat();

    if (!types.includes("Offer") || offer.priceCurrency !== "SGD") {
      return false;
    }

    const price = Number(offer.price);

    if (
      offer.price === null ||
      offer.price === undefined ||
      offer.price === "" ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return false;
    }

    if (offer.priceValidUntil) {
      const expiry = Date.parse(offer.priceValidUntil);

      if (Number.isFinite(expiry) && expiry + 86_400_000 < Date.now()) {
        return false;
      }
    }

    if (offer.url && getProductUrl(offer.url) !== pageUrl) {
      return false;
    }

    return true;
  });

  // Ambiguous offers should not produce an arbitrary price.
  const prices = new Set(validOffers.map((offer) => Number(offer.price)));

  if (prices.size !== 1) {
    return null;
  }

  const availability = validOffers[0].availability;

  return {
    name: product.name.trim(),
    price: [...prices][0],
    currency: "SGD",
    availability:
      typeof availability === "string"
        ? availability.split("/").pop()
        : null,
    url: pageUrl,
    checkedAt: new Date().toISOString()
  };
}

async function readProduct(context, url) {
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 20_000
    });

    await page
      .waitForSelector('script[type="application/ld+json"]', {
        state: "attached",
        timeout: 8_000
      })
      .catch(() => {});

    // Redirects to login, challenge, or other pages are not product data.
    if (getProductUrl(page.url()) !== url) {
      return null;
    }

    const documents = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents();

    for (const document of documents) {
      let data;

      try {
        data = JSON.parse(document);
      } catch {
        continue;
      }

      for (const product of collectProducts(data)) {
        if (product.url && getProductUrl(product.url) !== url) {
          continue;
        }

        const result = getVerifiedOffer(product, url);

        if (result) {
          return result;
        }
      }
    }

    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function searchFairPrice(query) {
  if (busy) {
    const error = new Error("Another price lookup is running. Please try again.");
    error.status = 503;
    throw error;
  }

  busy = true;
  let context;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      locale: "en-SG",
      timezoneId: "Asia/Singapore"
    });

    const page = await context.newPage();
    const searchUrl = new URL("/search", BASE_URL);
    searchUrl.searchParams.set("query", query);

    await page.goto(searchUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: 25_000
    });

    await page.waitForSelector('a[href*="/product/"]', {
      timeout: 15_000
    });

    const links = await page
      .locator('a[href*="/product/"]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("href"))
      );

    const urls = [...new Set(links.map(getProductUrl).filter(Boolean))]
      .slice(0, MAX_PRODUCTS);

    await page.close();

    const products = [];

    for (const url of urls) {
      try {
        const product = await readProduct(context, url);

        if (product) {
          products.push(product);
        }
      } catch (error) {
        console.warn("Product lookup failed:", url, error.message);
      }
    }

    return {
      products,
      searchUrl: searchUrl.href
    };
  } finally {
    await context?.close().catch(() => {});
    busy = false;
  }
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    await browser?.close();
    browserPromise = undefined;
  }
}
