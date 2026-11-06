export type BookingStatus = 'HOLD' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';

export interface Booking {
  id: string;
  roomId: number;
  userId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  bedLayout: string;
  totalPrice: number;
  status: BookingStatus;
  holdExpiresAt: string | null;
  version: number;
  lamport: number;
  instanceId: string;
  updatedAt: string;
  receiptCode?: string | null;
  guestName?: string;
  createdAt?: string;
}

export interface HotelEvent {
  seq: number;
  type: string;
  payload: any;
  lamport: number;
  instanceId: string;
  createdAt: string;
}

export interface Room {
  id: number;
  floor: number;
  kind: 'FIXO' | 'ADAPTAVEL';
  layouts: string[];
  pricePerPerson: number;
}

export interface Catalog {
  basePrice: number;
  floorMultiplier: Record<string, number>;
  layouts: Record<string, { label: string; capacity: number }>;
  rooms: Room[];
  holdSeconds: number;
}

export interface User {
  id: string;
  name: string;
  role: 'GUEST' | 'RECEPTION';
  expiresAt: string;
}

export interface LabRound {
  id: number;
  mode: 'SAFE' | 'NAIVE';
  fireAt: string;
  createdBy: string;
}

export interface LabAttempt {
  id: number;
  roundId: number;
  userId: string;
  userName: string;
  success: boolean;
  lamport: number;
  instanceId: string;
  receivedAt: string;
}
