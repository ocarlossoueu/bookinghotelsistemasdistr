/**
 * Regras de negócio do hotel: apartamentos, camas e preços.
 * Prédio com térreo (recepção) + 3 andares, 4 apartamentos por andar = 12 apartamentos.
 */

export const BASE_PRICE_PER_PERSON = 100; // R$ por pessoa por diária
export const MAX_GUESTS = 4;
export const MAX_NIGHTS = 30;

export const FLOOR_MULTIPLIER: Record<number, number> = { 1: 0.9, 2: 1.0, 3: 1.1 };

export const LAYOUTS = {
  SOLTEIRO: { label: '1 cama de solteiro', capacity: 1 },
  CASAL: { label: '1 cama de casal', capacity: 2 },
  DOIS_SOLTEIROS: { label: '2 camas de solteiro', capacity: 2 },
  CASAL_SOLTEIRO: { label: '1 casal + 1 solteiro', capacity: 3 },
  TRES_SOLTEIROS: { label: '3 camas de solteiro', capacity: 3 },
  CASAL_DOIS_SOLTEIROS: { label: '1 casal + 2 solteiros', capacity: 4 },
  DOIS_CASAIS: { label: '2 camas de casal', capacity: 4 },
  QUATRO_SOLTEIROS: { label: '4 camas de solteiro', capacity: 4 },
} as const;

export type LayoutCode = keyof typeof LAYOUTS;

export interface Room {
  id: number;
  floor: number;
  kind: 'FIXO' | 'ADAPTAVEL';
  layouts: LayoutCode[];
  pricePerPerson: number;
}

const ADAPTABLE: LayoutCode[] = Object.keys(LAYOUTS) as LayoutCode[];

export const ROOMS: Room[] = [1, 2, 3].flatMap((floor) =>
  [1, 2, 3, 4].map((n) => ({
    id: floor * 100 + n,
    floor,
    // Os 4 apartamentos do último andar têm configuração fixa: casal + 2 solteiros.
    kind: floor === 3 ? ('FIXO' as const) : ('ADAPTAVEL' as const),
    layouts: floor === 3 ? (['CASAL_DOIS_SOLTEIROS'] as LayoutCode[]) : ADAPTABLE,
    pricePerPerson: round2(BASE_PRICE_PER_PERSON * FLOOR_MULTIPLIER[floor]),
  })),
);

export function getRoom(id: number): Room | undefined {
  return ROOMS.find((r) => r.id === id);
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function quote(room: Room, guests: number, checkIn: string, checkOut: string) {
  const nights = nightsBetween(checkIn, checkOut);
  return {
    nights,
    pricePerPerson: room.pricePerPerson,
    total: round2(room.pricePerPerson * guests * nights),
  };
}

/** Valida se a configuração de camas é permitida para o apartamento e comporta os hóspedes. */
export function validateLayout(room: Room, layout: LayoutCode, guests: number): string | null {
  if (!room.layouts.includes(layout)) return 'Configuração de camas não disponível neste apartamento';
  if (LAYOUTS[layout].capacity < guests) return 'A configuração de camas não comporta todos os hóspedes';
  return null;
}
