/**
 * GraphQL Admin API (2026-10): керування CarrierService (тарифи доставки в Checkout).
 * Поля звірено з shopify.dev: DeliveryCarrierService, carrierServices, carrierServiceCreate/Update/Delete,
 * DeliveryCarrierServiceCreateInput / DeliveryCarrierServiceUpdateInput, CarrierService*UserError.
 *
 * Доступи: мутації — `write_shipping`; запит `carrierServices` — `read_shipping` (входить у `write_shipping`).
 */

const SERVICE_FIELDS = "id name callbackUrl active supportsServiceDiscovery";
const USER_ERRORS = "userErrors { field message code }";

/** Перша сторінка (50) — більше сервісів на один магазин не очікуємо; ліміт кількості НЕ задокументований. */
export const CARRIER_SERVICES_QUERY = `#graphql
  query OtCarrierServices {
    carrierServices(first: 50) { nodes { ${SERVICE_FIELDS} } }
  }`;

/**
 * Чи ввімкнено в магазині доставку за ринками (market-driven shipping): ShopFeatures.marketDrivenShipping
 * («Whether market-driven shipping is enabled for the shop», API 2026-07+). У такому магазині тарифи із зон
 * профілів доставки, створених продавцем, Checkout ігнорує (deliveryProfileUpdate, 2026-10) — тарифи застосунку
 * вмикаються в доставці ринку (Markets).
 */
export const SHOP_SHIPPING_FEATURES_QUERY = `#graphql
  query OtShopShippingFeatures {
    shop { features { marketDrivenShipping } }
  }`;

export interface GqlShopShippingFeatures {
  shop: { features: { marketDrivenShipping: boolean | null } | null } | null;
}

export const CARRIER_SERVICE_CREATE_MUTATION = `#graphql
  mutation OtCarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
    carrierServiceCreate(input: $input) { carrierService { ${SERVICE_FIELDS} } ${USER_ERRORS} }
  }`;

export const CARRIER_SERVICE_UPDATE_MUTATION = `#graphql
  mutation OtCarrierServiceUpdate($input: DeliveryCarrierServiceUpdateInput!) {
    carrierServiceUpdate(input: $input) { carrierService { ${SERVICE_FIELDS} } ${USER_ERRORS} }
  }`;

export const CARRIER_SERVICE_DELETE_MUTATION = `#graphql
  mutation OtCarrierServiceDelete($id: ID!) {
    carrierServiceDelete(id: $id) { deletedId ${USER_ERRORS} }
  }`;

export interface GqlCarrierService {
  /** Напр. gid://shopify/DeliveryCarrierService/1036895098 */
  id: string;
  name: string | null;
  /** Може бути null (приклад документації; причина не задокументована — напр. сервіс іншого застосунку). */
  callbackUrl: string | null;
  active: boolean;
  supportsServiceDiscovery: boolean;
}

/** Єдиний код у кожному enum: CARRIER_SERVICE_CREATE_FAILED / _UPDATE_FAILED / _DELETE_FAILED. */
export interface GqlCarrierServiceUserError {
  field: string[] | null;
  message: string;
  code: string | null;
}

/** DeliveryCarrierServiceCreateInput — усі поля обов'язкові. */
export interface CarrierServiceCreateInput {
  name: string;
  callbackUrl: string;
  supportsServiceDiscovery: boolean;
  active: boolean;
}

/** DeliveryCarrierServiceUpdateInput — обов'язковий лише id. «Only the app that creates a carrier service can update it.» */
export interface CarrierServiceUpdateInput {
  id: string;
  name?: string;
  callbackUrl?: string;
  supportsServiceDiscovery?: boolean;
  active?: boolean;
}

export interface CarrierServicesQueryData {
  carrierServices: { nodes: GqlCarrierService[] };
}

export interface CarrierServiceCreateData {
  carrierServiceCreate: { carrierService: GqlCarrierService | null; userErrors: GqlCarrierServiceUserError[] };
}

export interface CarrierServiceUpdateData {
  carrierServiceUpdate: { carrierService: GqlCarrierService | null; userErrors: GqlCarrierServiceUserError[] };
}

export interface CarrierServiceDeleteData {
  carrierServiceDelete: { deletedId: string | null; userErrors: GqlCarrierServiceUserError[] };
}
