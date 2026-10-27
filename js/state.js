import { supabase } from './supabase.js';

// Shared app state: the signed-in person and the people list
export const state = {
  me: null,
  people: [],
};

export const isAdmin = () => state.me?.role === 'admin';
export const isDirector = () => state.me?.role === 'director';
// Admins and team members create and edit work; directors only view
export const canEditWork = () => ['admin', 'member'].includes(state.me?.role);

export function personById(id) {
  return state.people.find(p => p.id === id) || null;
}

// Returns the signed-in person, or null if they have no active account
export async function loadMe(userId) {
  const { data, error } = await supabase.from('people').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  state.me = data && data.active ? data : null;
  return state.me;
}

export async function loadPeople() {
  const { data, error } = await supabase.from('people').select('*').order('name');
  if (error) throw error;
  state.people = data;
  state.me = data.find(p => p.id === state.me?.id) || state.me;
  return data;
}
