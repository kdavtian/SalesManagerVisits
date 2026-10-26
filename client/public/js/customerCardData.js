// What the customer card's sheets and the All orders page read, with the key each is kept under on this phone (listCache.js). One place, so
// the screen that opens the data and the code that starts loading it as a finger lands use exactly the same request.
import { api } from "./api.js";

export const paymentsSource = (id) => ({ key: `cust-payments:${id}`, fetch: () => api.getCustomerPaymentsReceived(id) });
export const allOrdersSource = (id) => ({ key: `cust-orders-all:${id}`, fetch: () => api.getErpOrders(id, "all") });
export const orderDetailSource = (id, orderId) => ({ key: `cust-order:${id}:${orderId}`, fetch: () => api.getErpOrderDetail(id, orderId) });
export const photosSource = (id) => ({ key: `cust-photos:${id}`, fetch: () => api.customerPhotos(id) });
