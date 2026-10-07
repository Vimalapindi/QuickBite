export type Role = 'CUSTOMER' | 'RESTAURANT_OWNER' | 'DELIVERY_PARTNER' | 'ADMIN';
export type OrderStatus =
  | 'PLACED' | 'PAID' | 'CONFIRMED' | 'PREPARING' | 'READY_FOR_PICKUP' | 'PICKED_UP' | 'DELIVERED'
  | 'CANCELLED' | 'REJECTED' | 'PAYMENT_FAILED';

export interface User { id: string; email: string; name: string; role: Role; phone: string | null }
export interface RestaurantSummary { id: string; name: string; description: string | null; cuisine: string; city: string; isOpen: boolean; deliveryFeeCents: number }
export interface MenuItemPublic { id: string; name: string; description: string | null; priceCents: number; categoryId: string | null; isAvailable: boolean; soldOut: boolean }
export interface Category { id: string; name: string; sortOrder: number }
export interface RestaurantDetail extends RestaurantSummary { categories: Category[]; items: MenuItemPublic[]; address: string }
export interface CartLine { menuItemId: string; name: string; priceCents: number; quantity: number; lineTotalCents: number; isAvailable: boolean }
export interface Cart { restaurant: { id: string; name: string; isOpen: boolean; deliveryFeeCents: number } | null; items: CartLine[]; subtotalCents: number; deliveryFeeCents: number; totalCents: number }
export interface Address { id: string; label: string | null; line1: string; city: string; pincode: string }
export interface Order {
  id: string; status: OrderStatus; totalCents: number; subtotalCents: number; deliveryFeeCents: number; placedAt: string;
  restaurant: { id: string; name: string };
  items: { menuItemId: string; name: string; priceCents: number; quantity: number }[];
  payment: { status: string; failureReason: string | null } | null;
  delivery: { partnerId: string; status: string } | null;
  nextStatuses?: OrderStatus[];
}
export interface Notification { id: string; type: string; title: string; body: string; readAt: string | null; createdAt: string }
