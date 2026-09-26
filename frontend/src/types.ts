export type Point = { lat: number; lng: number };
export type Place = Point & {
  id: string;
  name: string;
  address?: string;
  photo?: string | null;
  attribution?: string[];
};
export type Mode =
  | "WALK"
  | "BUS"
  | "TRAIN"
  | "METRO"
  | "AUTO"
  | "CAB"
  | "BIKE"
  | "CAR"
  | "EV"
  | "BICYCLE";
export type Leg = {
  mode: Mode;
  origin: Place;
  destination: Place;
  distance: number;
  duration: number;
  cost: number | null;
  source: string;
  confidence: string;
  polyline: Point[];
  steps: { instruction: string; distance: number; end: Point }[];
  line?: string;
  headsign?: string;
  fare_kind?: "bus" | "share_auto" | "auto" | "cab" | null;
  base_fare?: number | null;
  fare_basis?: string | null;
  fare_reports?: number;
};
export type FuelPrice = {
  price: number;
  unit: string;
  source: string;
  checked: string;
};
export type MileagePreset = {
  name: string;
  mode: "BIKE" | "CAR" | "EV";
  fuel: "Petrol" | "Diesel" | "CNG" | "Electricity";
  efficiency: number;
};
export type FareResearch = {
  fuel_prices: Record<string, FuelPrice>;
  mileage_presets: MileagePreset[];
  mileage_source: string;
  stree_shakti: string;
};
export type Route = {
  id: string;
  name: string;
  legs: Leg[];
  demo: boolean;
  cost: number | null;
  duration: number;
  distance: number;
  walking: number;
  transfers: number;
  score: number;
  cost_label: string;
};
export type Vehicle = {
  name: string;
  mode: "BIKE" | "CAR" | "EV";
  fuel: "Petrol" | "Diesel" | "CNG" | "Electricity";
  efficiency: number;
  unit_price: number;
  parking: number;
  toll: number;
};
export type Log = {
  time: string;
  event: string;
  level: "INFO" | "WARN" | "ERROR";
  detail: string;
};
