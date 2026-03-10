'use server';

import { createClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/crypto';

export type BotStatus = 'RUNNING' | 'STOPPED' | 'ERROR_AUTH' | 'PAUSED_RATE_LIMIT';

export interface AddClientInput {
  name: string;
  email: string;
  password: string;
  minPrice: number;
  minHoursFromNow?: number;
  vehicleTypes: string[];
  timezone: string;
  locale: string;
  latitude: number;
  longitude: number;
}

export interface UpdateClientInput {
  name?: string;
  email?: string;
  password?: string;
  minPrice?: number;
  minHoursFromNow?: number;
  /** Min minutes between offer and existing ride. Use null to clear. */
  minGapMinutes?: number | null;
  vehicleTypes?: string[];
  timezone?: string;
  locale?: string;
  latitude?: number;
  longitude?: number;
}

function isNonEmptyString(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

function isValidNumber(n: unknown): n is number {
  return typeof n === 'number' && !Number.isNaN(n) && n >= -90 && n <= 90;
}

function isValidLongitude(n: unknown): n is number {
  return typeof n === 'number' && !Number.isNaN(n) && n >= -180 && n <= 180;
}

export async function addClient(input: AddClientInput) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated' };
  }

  if (!isNonEmptyString(input.timezone)) {
    return { error: 'Timezone is required' };
  }
  if (!isNonEmptyString(input.locale)) {
    return { error: 'Locale is required' };
  }
  if (!isValidNumber(input.latitude)) {
    return { error: 'Latitude must be a number between -90 and 90' };
  }
  if (!isValidLongitude(input.longitude)) {
    return { error: 'Longitude must be a number between -180 and 180' };
  }

  const encryptedPassword = encrypt(input.password);
  const filters: Record<string, unknown> = {
    minPrice: input.minPrice,
    allowedVehicleTypes: input.vehicleTypes
      .filter(Boolean)
      .map((v) => v.trim().toLowerCase())
      .filter((v, idx, arr) => arr.indexOf(v) === idx),
  };
  if (typeof input.minHoursFromNow === 'number' && input.minHoursFromNow > 0) {
    filters.minHoursFromNow = input.minHoursFromNow;
  }
  const { data, error } = await supabase
    .from('bots')
    .insert({
      user_id: user.id,
      name: input.name.trim() || null,
      email: input.email.trim().toLowerCase(),
      password: encryptedPassword,
      filters,
      status: 'STOPPED',
      timezone: input.timezone.trim(),
      locale: input.locale.trim(),
      latitude: input.latitude,
      longitude: input.longitude,
    })
    .select('id, email, name')
    .single();

  if (error) {
    return { error: error.message };
  }
  return { data };
}

export async function updateClient(
  id: string,
  input: UpdateClientInput
) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated' };
  }

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name.trim() || null;
  if (input.email !== undefined) updates.email = input.email.trim().toLowerCase();
  if (input.password !== undefined) updates.password = encrypt(input.password);
  if (input.timezone !== undefined) {
    if (!isNonEmptyString(input.timezone)) {
      return { error: 'Timezone cannot be empty' };
    }
    updates.timezone = input.timezone.trim();
  }
  if (input.locale !== undefined) {
    if (!isNonEmptyString(input.locale)) {
      return { error: 'Locale cannot be empty' };
    }
    updates.locale = input.locale.trim();
  }
  if (input.latitude !== undefined) {
    if (!isValidNumber(input.latitude)) {
      return { error: 'Latitude must be a number between -90 and 90' };
    }
    updates.latitude = input.latitude;
  }
  if (input.longitude !== undefined) {
    if (!isValidLongitude(input.longitude)) {
      return { error: 'Longitude must be a number between -180 and 180' };
    }
    updates.longitude = input.longitude;
  }
  if (
    input.minPrice !== undefined ||
    input.minHoursFromNow !== undefined ||
    input.minGapMinutes !== undefined ||
    input.vehicleTypes !== undefined
  ) {
    const { data: existing } = await supabase
      .from('bots')
      .select('filters')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();
    const filters = (existing?.filters ?? {}) as Record<string, unknown>;
    if (input.minPrice !== undefined) filters.minPrice = input.minPrice;
    if (input.minHoursFromNow !== undefined) {
      if (input.minHoursFromNow > 0) {
        filters.minHoursFromNow = input.minHoursFromNow;
      } else {
        delete filters.minHoursFromNow;
      }
    }
    if (input.minGapMinutes !== undefined) {
      if (typeof input.minGapMinutes === 'number' && input.minGapMinutes >= 0) {
        filters.minGapMinutes = input.minGapMinutes;
      } else {
        delete filters.minGapMinutes;
      }
    }
    if (input.vehicleTypes !== undefined) {
      filters.allowedVehicleTypes = input.vehicleTypes
        .filter(Boolean)
        .map((v) => v.trim().toLowerCase())
        .filter((v, idx, arr) => arr.indexOf(v) === idx);
    }
    updates.filters = filters;
  }

  if (Object.keys(updates).length === 0) {
    return { error: 'No updates provided' };
  }

  const { data, error } = await supabase
    .from('bots')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) {
    return { error: error.message };
  }
  return { data };
}

export async function deleteClient(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated' };
  }
  const { error } = await supabase.from('bots').delete().eq('id', id).eq('user_id', user.id);
  if (error) {
    return { error: error.message };
  }
  return {};
}

export async function toggleClientStatus(id: string, currentStatus: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated' };
  }
  const newStatus = currentStatus === 'RUNNING' ? 'STOPPED' : 'RUNNING';
  const { data, error } = await supabase
    .from('bots')
    .update({ status: newStatus })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('status')
    .single();

  if (error) {
    return { error: error.message };
  }
  return { data };
}
