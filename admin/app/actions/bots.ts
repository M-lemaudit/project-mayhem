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
}

export interface UpdateClientInput {
  name?: string;
  email?: string;
  password?: string;
  minPrice?: number;
  minHoursFromNow?: number;
  vehicleTypes?: string[];
}

export async function addClient(input: AddClientInput) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { error: 'Not authenticated' };
  }

  const encryptedPassword = encrypt(input.password);
  const filters: Record<string, unknown> = {
    minPrice: input.minPrice,
    allowedVehicleTypes: input.vehicleTypes.filter(Boolean),
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
  if (input.minPrice !== undefined || input.vehicleTypes !== undefined) {
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
    if (input.vehicleTypes !== undefined) {
      filters.allowedVehicleTypes = input.vehicleTypes.filter(Boolean);
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
