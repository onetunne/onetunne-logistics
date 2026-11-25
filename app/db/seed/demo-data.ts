/**
 * ВИГАДАНІ демонстраційні дані. Жодних реальних клієнтів: імена шаблонні,
 * email — у зарезервованих доменах example.com/example.org, адреси вигадані.
 * Кожне замовлення ілюструє певний сценарій перевірки даних.
 */

export interface DemoVariantSeed {
  key: string;
  title: string;
  sku: string;
  barcode: string;
  color: string | null;
  model: string | null;
  price: string;
  weightGrams: number | null;
  hsCode: string | null;
  countryOfOrigin: string | null;
  customsDescription: string | null;
  inventoryAvailable: number;
}

export interface DemoProductSeed {
  key: string;
  title: string;
  handle: string;
  imageUrl: string;
  variants: DemoVariantSeed[];
}

export const DEMO_PRODUCTS: DemoProductSeed[] = [
  {
    key: "holder",
    title: "Тримач телефону Pro",
    handle: "phone-holder-pro",
    imageUrl: "/demo-images/phone-holder.svg",
    variants: [
      { key: "holder-black", title: "Чорний", sku: "OT-PH-BLK", barcode: "4820000000017", color: "Чорний", model: null, price: "29.00", weightGrams: 120, hsCode: "8714.10", countryOfOrigin: "UA", customsDescription: "Phone holder for electric scooter", inventoryAvailable: 42 },
      { key: "holder-white", title: "Білий", sku: "OT-PH-WHT", barcode: "4820000000024", color: "Білий", model: null, price: "29.00", weightGrams: 120, hsCode: "8714.10", countryOfOrigin: "UA", customsDescription: "Phone holder for electric scooter", inventoryAvailable: 7 },
    ],
  },
  {
    key: "fender",
    title: "Крило заднє",
    handle: "rear-fender",
    imageUrl: "/demo-images/fender.svg",
    variants: [
      { key: "fender-x", title: "Model X", sku: "OT-FK-X", barcode: "4820000000031", color: null, model: "Model X", price: "34.50", weightGrams: 350, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Rear fender for electric scooter", inventoryAvailable: 18 },
      { key: "fender-s", title: "Model S", sku: "OT-FK-S", barcode: "4820000000048", color: null, model: "Model S", price: "34.50", weightGrams: 340, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Rear fender for electric scooter", inventoryAvailable: 3 },
    ],
  },
  {
    key: "grips",
    title: "Грипси силіконові",
    handle: "silicone-grips",
    imageUrl: "/demo-images/grips.svg",
    variants: [
      { key: "grips-black", title: "Чорні", sku: "OT-GR-BLK", barcode: "4820000000055", color: "Чорний", model: null, price: "14.90", weightGrams: 90, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Silicone handlebar grips", inventoryAvailable: 60 },
      { key: "grips-gray", title: "Сірі", sku: "OT-GR-GRY", barcode: "4820000000062", color: "Сірий", model: null, price: "14.90", weightGrams: 90, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Silicone handlebar grips", inventoryAvailable: 25 },
    ],
  },
  {
    key: "bag",
    title: "Сумка на кермо Mini",
    handle: "handlebar-bag-mini",
    imageUrl: "/demo-images/bag.svg",
    variants: [
      { key: "bag-black", title: "Чорна", sku: "OT-BG-BLK", barcode: "4820000000079", color: "Чорний", model: null, price: "39.00", weightGrams: 250, hsCode: "420292", countryOfOrigin: "UA", customsDescription: "Textile handlebar bag", inventoryAvailable: 12 },
    ],
  },
  {
    key: "light",
    title: "Комплект світла LED",
    handle: "led-light-set",
    imageUrl: "/demo-images/light.svg",
    variants: [
      { key: "light-std", title: "Стандарт", sku: "OT-LT-STD", barcode: "4820000000086", color: null, model: null, price: "24.90", weightGrams: 180, hsCode: "851210", countryOfOrigin: "UA", customsDescription: "LED lighting set for scooter", inventoryAvailable: 30 },
    ],
  },
  {
    key: "tire",
    title: "Покришка 10x2.5",
    handle: "tire-10x25",
    imageUrl: "/demo-images/tire.svg",
    variants: [
      // Навмисно без HS-коду та митного опису — демонструє проблему з даними товару.
      { key: "tire-std", title: "Стандарт", sku: "OT-TR-1025", barcode: "4820000000093", color: null, model: "10x2.5", price: "27.00", weightGrams: 900, hsCode: null, countryOfOrigin: "UA", customsDescription: null, inventoryAvailable: 9 },
    ],
  },
];

export interface DemoOrderSeed {
  number: string;
  /** Скільки годин тому оформлено. */
  hoursAgo: number;
  scenario: string;
  email: string | null;
  contactPhone: string | null;
  shipping: {
    firstName: string | null;
    lastName: string | null;
    company?: string | null;
    address1: string | null;
    address2?: string | null;
    city: string | null;
    province?: string | null;
    postalCode: string | null;
    countryCode: string | null;
    phone: string | null;
  };
  items: { variant: string; quantity: number }[];
  shippingPaid: string;
  /** Історичні замовлення: довести до цього стану через сервіси під час заповнення. */
  history?: "waybill" | "delivered" | "cancelled";
}

export const DEMO_ORDERS: DemoOrderSeed[] = [
  {
    number: "#1001", hoursAgo: 2, scenario: "clean",
    email: "lena.h@example.com", contactPhone: null,
    shipping: { firstName: "Lena", lastName: "Hoffmann", address1: "Musterstraße 12", city: "Berlin", postalCode: "10115", countryCode: "DE", phone: "+49 1512 3456789" },
    items: [{ variant: "holder-black", quantity: 1 }, { variant: "grips-black", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    number: "#1002", hoursAgo: 3, scenario: "autofix: 00-prefix phone + PL postal format",
    email: "marta.n@example.com", contactPhone: null,
    shipping: { firstName: "Marta", lastName: "Nowak", address1: "ul. Przykładowa 5/12", city: "Warszawa", postalCode: "00950", countryCode: "PL", phone: "0048 512 345 678" },
    items: [{ variant: "fender-x", quantity: 1 }], shippingPaid: "11.00",
  },
  {
    number: "#1003", hoursAgo: 4, scenario: "autofix: GB postcode spacing/case + national phone",
    email: "oliver.s@example.org", contactPhone: null,
    shipping: { firstName: "Oliver", lastName: "Smith", address1: "221 Example Street", city: "London", postalCode: "sw1a1aa", countryCode: "gb", phone: "07400 123456" },
    items: [{ variant: "bag-black", quantity: 1 }], shippingPaid: "14.00",
  },
  {
    number: "#1004", hoursAgo: 5, scenario: "problem: missing postal code (manual fix)",
    email: "camille.m@example.com", contactPhone: null,
    shipping: { firstName: "Camille", lastName: "Martin", address1: "12 Rue de l'Exemple", city: "Lyon", postalCode: null, countryCode: "FR", phone: "+33 6 12 34 56 78" },
    items: [{ variant: "holder-white", quantity: 2 }], shippingPaid: "12.00",
  },
  {
    number: "#1005", hoursAgo: 6, scenario: "problem: missing US state",
    email: "emily.j@example.com", contactPhone: null,
    shipping: { firstName: "Emily", lastName: "Johnson", address1: "1200 Example Ave", city: "Austin", province: null, postalCode: "73301", countryCode: "US", phone: "+1 202 555 0123" },
    items: [{ variant: "light-std", quantity: 1 }, { variant: "grips-gray", quantity: 2 }], shippingPaid: "19.00",
  },
  {
    number: "#1006", hoursAgo: 7, scenario: "problem: ambiguous phone (needs manager choice)",
    email: "giulia.r@example.com", contactPhone: null,
    shipping: { firstName: "Giulia", lastName: "Rossi", address1: "Via Esempio 8", city: "Milano", postalCode: "20121", countryCode: "IT", phone: "3612345678" },
    items: [{ variant: "fender-s", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    number: "#1007", hoursAgo: 9, scenario: "autofix: 00-prefix phone + NL postcode",
    email: "daan.v@example.org", contactPhone: null,
    shipping: { firstName: "Daan", lastName: "de Vries", address1: "Voorbeeldstraat 7", city: "Amsterdam", postalCode: "1012ab", countryCode: "NL", phone: "0031 6 12345678" },
    items: [{ variant: "grips-black", quantity: 1 }], shippingPaid: "11.00",
  },
  {
    number: "#1008", hoursAgo: 11, scenario: "problem: product missing HS code / customs description",
    email: "lucia.g@example.com", contactPhone: null,
    shipping: { firstName: "Lucía", lastName: "García", address1: "Calle Ejemplo 3", city: "Madrid", postalCode: "28013", countryCode: "ES", phone: "+34 612 34 56 78" },
    items: [{ variant: "tire-std", quantity: 2 }], shippingPaid: "18.00",
  },
  {
    number: "#1009", hoursAgo: 13, scenario: "clean: country without postal codes",
    email: "omar.h@example.com", contactPhone: null,
    shipping: { firstName: "Omar", lastName: "Haddad", address1: "Example Tower, Office 1203", city: "Dubai", postalCode: null, countryCode: "AE", phone: "+971 50 123 4567" },
    items: [{ variant: "holder-black", quantity: 1 }], shippingPaid: "22.00",
  },
  {
    number: "#1010", hoursAgo: 15, scenario: "problem: shipping to country disabled",
    email: "ivan.p@example.com", contactPhone: null,
    shipping: { firstName: "Ivan", lastName: "Petrov", address1: "Primernaya ul. 1", city: "Moskva", postalCode: "101000", countryCode: "RU", phone: "+7 912 345 67 89" },
    items: [{ variant: "light-std", quantity: 1 }], shippingPaid: "20.00",
  },
  {
    number: "#1011", hoursAgo: 18, scenario: "autofix: CA postal format",
    email: "noah.t@example.org", contactPhone: null,
    shipping: { firstName: "Noah", lastName: "Tremblay", address1: "100 Example Rd", city: "Ottawa", province: "ON", postalCode: "k1a0b1", countryCode: "CA", phone: "+1 613 555 0199" },
    items: [{ variant: "bag-black", quantity: 1 }], shippingPaid: "21.00",
  },
  {
    number: "#1012", hoursAgo: 20, scenario: "autofix: copy contact phone to shipping phone",
    email: "felix.w@example.com", contactPhone: "+49 170 1234567",
    shipping: { firstName: "Felix", lastName: "Wagner", address1: "Beispielweg 4", city: "München", postalCode: "80331", countryCode: "DE", phone: null },
    items: [{ variant: "fender-x", quantity: 1 }, { variant: "holder-white", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    number: "#1013", hoursAgo: 23, scenario: "problems: missing city + phone contains a letter",
    email: "elsa.l@example.com", contactPhone: null,
    shipping: { firstName: "Elsa", lastName: "Lindqvist", address1: "Exempelgatan 2", city: null, postalCode: "11122", countryCode: "SE", phone: "+46 70 123 45 6O" },
    items: [{ variant: "grips-gray", quantity: 1 }], shippingPaid: "13.00",
  },
  // Історичні замовлення (ілюструють подальші статуси).
  {
    number: "#0998", hoursAgo: 30, scenario: "history: test waybill created", history: "waybill",
    email: "jonas.k@example.com", contactPhone: null,
    shipping: { firstName: "Jonas", lastName: "Keller", address1: "Probegasse 9", city: "Wien", postalCode: "1010", countryCode: "AT", phone: "+43 664 1234567" },
    items: [{ variant: "light-std", quantity: 1 }], shippingPaid: "13.00",
  },
  {
    number: "#0997", hoursAgo: 120, scenario: "history: delivered", history: "delivered",
    email: "piotr.w@example.com", contactPhone: null,
    shipping: { firstName: "Piotr", lastName: "Wiśniewski", address1: "ul. Testowa 1", city: "Kraków", postalCode: "30-001", countryCode: "PL", phone: "+48 601 234 567" },
    items: [{ variant: "grips-black", quantity: 2 }], shippingPaid: "11.00",
  },
  {
    number: "#0996", hoursAgo: 72, scenario: "history: cancelled before handover", history: "cancelled",
    email: "chloe.b@example.com", contactPhone: null,
    shipping: { firstName: "Chloé", lastName: "Bernard", address1: "5 Avenue Exemple", city: "Paris", postalCode: "75001", countryCode: "FR", phone: "+33 6 98 76 54 32" },
    items: [{ variant: "holder-black", quantity: 1 }], shippingPaid: "12.00",
  },
];

/** Шаблони для кнопки «Імітувати нове оплачене замовлення» (по колу, детерміновано). */
export const SIMULATED_ORDER_TEMPLATES: Omit<DemoOrderSeed, "number" | "hoursAgo">[] = [
  {
    scenario: "simulated: clean",
    email: "anna.k@example.com", contactPhone: null,
    shipping: { firstName: "Anna", lastName: "Kovalenko", address1: "Beispielallee 21", city: "Hamburg", postalCode: "20095", countryCode: "DE", phone: "+49 151 23456780" },
    items: [{ variant: "grips-black", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    scenario: "simulated: missing postal code",
    email: "sofia.m@example.org", contactPhone: null,
    shipping: { firstName: "Sofia", lastName: "Moretti", address1: "Via Prova 15", city: "Roma", postalCode: null, countryCode: "IT", phone: "+39 312 345 6789" },
    items: [{ variant: "holder-white", quantity: 1 }], shippingPaid: "12.00",
  },
  {
    scenario: "simulated: autofix phone format",
    email: "jan.d@example.com", contactPhone: null,
    shipping: { firstName: "Jan", lastName: "Dvořák", address1: "Ukázková 10", city: "Praha", postalCode: "11000", countryCode: "CZ", phone: "00420 601 123 456" },
    items: [{ variant: "fender-s", quantity: 1 }], shippingPaid: "12.00",
  },
];

export const DEMO_SHIPPER = {
  companyName: "ONE TUNNE (демо)",
  contactName: "Demo Manager",
  phone: "+380 67 000 0000",
  email: "logistics@example.com",
  countryCode: "UA",
  city: "Київ",
  postalCode: "01001",
  address1: "вул. Демонстраційна, 1",
  address2: "",
  warehouseName: "Склад Київ (демо)",
  carrierBranch: "Тестове відділення №1",
};
