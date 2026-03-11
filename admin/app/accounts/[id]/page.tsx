'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, type BotRow } from '@/lib/supabase';
import Link from 'next/link';
import { updateClient, toggleClientStatus } from '@/app/actions/bots';
import { LiveSnipeLog } from '@/components/live-snipe-log';

interface AccountPageProps {
  params: { id: string };
}

export default function AccountPage({ params }: AccountPageProps) {
  const { id } = params;
  const router = useRouter();
  const [bot, setBot] = useState<BotRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Filter states
  const [minPrice, setMinPrice] = useState(50);
  const [maxPrice, setMaxPrice] = useState(400);
  const [minDistance, setMinDistance] = useState(0);
  const [maxDistance, setMaxDistance] = useState(1000);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [minGapMinutes, setMinGapMinutes] = useState(0);
  const [rideType, setRideType] = useState('Both');
  const [vehicleClasses, setVehicleClasses] = useState<string[]>(['first']);
  const [airlineCode, setAirlineCode] = useState('');
  const [includedAirlines, setIncludedAirlines] = useState<string[]>([]);
  const [zipCodeInputAccept, setZipCodeInputAccept] = useState('');
  const [allowedZipCodes, setAllowedZipCodes] = useState<string[]>([]);
  const [zipCodeInputBlock, setZipCodeInputBlock] = useState('');
  const [blockedZipCodes, setBlockedZipCodes] = useState<string[]>([]);
  const [minLeadHours, setMinLeadHours] = useState(24);
  const [timezone, setTimezone] = useState('Europe/Paris');
  const [workingHours, setWorkingHours] = useState({ start: 6, end: 22 });
  const [isDirty, setIsDirty] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  
  // Settings Modal state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [updatingAccount, setUpdatingAccount] = useState(false);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  useEffect(() => {
    async function fetchBot() {
      const { data, error } = await supabase
        .from('bots')
        .select('*')
        .eq('id', id)
        .single();

      if (error || !data) {
        console.error('Failed to fetch bot', error);
        router.push('/dashboard');
        return;
      }

      const botData = data as BotRow;
      setBot(botData);

      // Initialize filters from DB
      const f = botData.filters || {};
      setMinPrice(Number(f.minPrice || f.min_price || 50));
      setMaxPrice(Number(f.maxPrice || f.max_price || 400));
      setMinDistance(Number(f.minDistance || f.min_distance || 0));
      setMaxDistance(Number(f.maxDistance || f.max_distance || 1000));
      setDateStart(String(f.dateStart || f.date_start || ''));
      setDateEnd(String(f.dateEnd || f.date_end || ''));
      setMinGapMinutes(Number(f.minGapMinutes || f.min_gap_minutes || 0));
      setRideType(String(f.rideType || f.ride_type || 'Both'));
      setVehicleClasses((f.allowedVehicleTypes || f.vehicle_classes || ['first']) as string[]);
      setIncludedAirlines((f.includedAirlines || f.included_airlines || []) as string[]);
      setAllowedZipCodes((f.allowedZipCodes || f.allowed_zip_codes || []) as string[]);
      setBlockedZipCodes((f.blockedZipCodes || f.blocked_zip_codes || []) as string[]);
      setMinLeadHours(Number(f.minLeadHours || f.min_lead_hours || 24));

      // Bot level settings
      setTimezone(botData.timezone || 'Europe/Paris');
      setWorkingHours((botData as any).working_hours || { start: 6, end: 22 });
      
      // Init settings modal fields
      setEditName(botData.name || '');
      setEditEmail(botData.email || '');

      setLoading(false);
    }

    fetchBot();
  }, [id, router]);

  const handleSave = async () => {
    setSaving(true);
    const updatedFilters = {
      minPrice,
      maxPrice,
      minDistance,
      maxDistance,
      dateStart,
      dateEnd,
      minGapMinutes,
      minLeadHours,
      rideType: rideType.trim().toLowerCase(),
      allowedVehicleTypes: vehicleClasses,
      includedAirlines,
      allowedZipCodes,
      blockedZipCodes,
    };

    const { error } = await supabase
      .from('bots')
      .update({
        filters: updatedFilters,
        timezone: timezone,
        working_hours: workingHours
      })
      .eq('id', id);

    if (error) {
      console.error('Failed to save filters:', error.message);
    } else {
      setIsDirty(false);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    }
    setSaving(false);
  };

  const handleUpdateAccount = async () => {
    setUpdatingAccount(true);
    const result = await updateClient(id, {
      name: editName,
      email: editEmail,
      password: editPassword || undefined
    });

    if (result.error) {
      alert('Failed to update account: ' + result.error);
    } else {
      setBot(prev => prev ? { ...prev, name: editName, email: editEmail } : null);
      setIsSettingsOpen(false);
      setEditPassword('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    }
    setUpdatingAccount(false);
  };

  const handleToggleStatus = async () => {
    if (!bot) return;
    setIsUpdatingStatus(true);
    const result = await toggleClientStatus(id, bot.status);
    
    if (result.error) {
      alert('Failed to update status: ' + result.error);
    } else if (result.data) {
      setBot({ ...bot, status: result.data.status });
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    }
    setIsUpdatingStatus(false);
  };

  const toggleVehicleClass = (vClass: string) => {
    setIsDirty(true);
    setVehicleClasses(prev =>
      prev.includes(vClass) ? prev.filter(c => c !== vClass) : [...prev, vClass]
    );
  };

  const addAirline = () => {
    if (airlineCode && !includedAirlines.includes(airlineCode.toUpperCase())) {
      setIsDirty(true);
      setIncludedAirlines([...includedAirlines, airlineCode.toUpperCase()]);
      setAirlineCode('');
    }
  };

  const removeAirline = (code: string) => {
    setIsDirty(true);
    setIncludedAirlines(includedAirlines.filter(c => c !== code));
  };

  const addZipCodeAccept = () => {
    if (zipCodeInputAccept && !allowedZipCodes.includes(zipCodeInputAccept.trim())) {
      setIsDirty(true);
      setAllowedZipCodes([...allowedZipCodes, zipCodeInputAccept.trim()]);
      setZipCodeInputAccept('');
    }
  };

  const removeZipCodeAccept = (code: string) => {
    setIsDirty(true);
    setAllowedZipCodes(allowedZipCodes.filter(c => c !== code));
  };

  const addZipCodeBlock = () => {
    if (zipCodeInputBlock && !blockedZipCodes.includes(zipCodeInputBlock.trim())) {
      setIsDirty(true);
      setBlockedZipCodes([...blockedZipCodes, zipCodeInputBlock.trim()]);
      setZipCodeInputBlock('');
    }
  };

  const removeZipCodeBlock = (code: string) => {
    setIsDirty(true);
    setBlockedZipCodes(blockedZipCodes.filter(c => c !== code));
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#171612] flex items-center justify-center text-primary">
        <div className="flex flex-col items-center gap-4">
          <span className="material-symbols-outlined text-5xl animate-spin">auto_transmission</span>
          <p className="text-slate-400 font-medium">Loading account settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#171612] text-slate-100 min-h-screen font-display">
      <div className="relative flex h-auto min-h-screen w-full flex-col overflow-x-hidden">
        <div className="layout-container flex h-full grow flex-col">
          <header className="flex items-center justify-between whitespace-nowrap border-b border-solid border-[#514c3e] px-6 md:px-10 py-4 bg-[#171612]/50 backdrop-blur-md sticky top-0 z-50">
            <div className="flex items-center gap-4">
              <div className="text-[#d4af35]">
                <span className="material-symbols-outlined text-3xl">auto_transmission</span>
              </div>
              <h2 className="text-slate-100 text-lg font-bold leading-tight tracking-[-0.015em] font-display">ChauffeurBot</h2>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-cover bg-center border border-[#514c3e]" style={{ backgroundImage: 'url("https://lh3.googleusercontent.com/aida-public/AB6AXuBdueTnP0AvdQ1MAO-X072TlNMJGI3fmLS0kWTDNjoEfIJZED3_ipBFr2RF_6JfuzSeLzsiF9RZt4qa9Tb5OkHdAIX07u2zkB24DHn9b-QilHSmBdlA8_TfE7fEVHXW6GMckRjxfKz3z3OVBpad7z_bvbS59FR-Ahbnv83hd1cThmtvOkeN89whFK1gkv39sBaODtZDW38hQxh0kpFDUP0-ioZxjl_oTVQCHuFuRT4jkYBd_JafYQKbx3lAXVKXl8nyaaAnJT2oWzOx")' }}></div>
            </div>
          </header>

          <main className="flex flex-col flex-1 px-4 md:px-10 py-8 max-w-7xl mx-auto w-full">
            <section className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8">
              <div className="flex items-center gap-5">
                <Link 
                  href="/dashboard"
                  className="group flex items-center justify-center size-10 rounded-xl border border-[#514c3e] bg-[#37342a]/30 text-slate-400 hover:text-[#d4af35] hover:border-[#d4af35] transition-all"
                >
                  <span className="material-symbols-outlined transition-transform group-hover:-translate-x-1">arrow_back</span>
                </Link>
                <div className="size-16 rounded-xl bg-cover bg-center border border-[#514c3e] flex items-center justify-center bg-black overflow-hidden shadow-2xl">
                  <span className="text-white font-black text-xs px-1 uppercase tracking-tighter">
                    {bot?.email?.split('@')[1]?.split('.')[0] || 'ACCOUNT'}
                  </span>
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <h1 className="text-white text-3xl font-bold tracking-tight font-display">{bot?.name || bot?.email}</h1>
                    <span className="bg-[#d4af35]/10 text-[#d4af35] text-[10px] font-bold px-2 py-0.5 rounded border border-[#d4af35]/20 uppercase tracking-widest">Premium</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    <p className="text-slate-400 text-sm flex items-center gap-1.5">
                      <span className={`size-2 rounded-full ${bot?.status === 'RUNNING' ? 'bg-[#d4af35] pulse-gold' : 'bg-slate-600'}`}></span>
                      Status: {bot?.status === 'RUNNING' ? 'Active' : 'Standby'}
                    </p>
                    <p className="text-slate-400 text-sm flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">sync</span>
                      Last sync: {bot?.last_seen ? new Date(bot.last_seen).toLocaleTimeString() : 'Never'}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4 w-full md:w-auto">
                <button 
                  onClick={handleToggleStatus}
                  disabled={isUpdatingStatus}
                  className={`flex-1 md:flex-none flex items-center justify-center gap-2 px-6 py-2.5 font-bold rounded-lg transition-all shadow-lg active:scale-95 disabled:opacity-50
                    ${bot?.status === 'RUNNING' 
                      ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20 hover:bg-rose-500 hover:text-white shadow-rose-500/10' 
                      : 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500 hover:text-white shadow-emerald-500/10'
                    }`}
                >
                  <span className={`material-symbols-outlined text-lg ${isUpdatingStatus ? 'animate-spin' : ''}`}>
                    {isUpdatingStatus ? 'sync' : bot?.status === 'RUNNING' ? 'stop_circle' : 'play_circle'}
                  </span>
                  {isUpdatingStatus 
                    ? 'Processing...' 
                    : bot?.status === 'RUNNING' ? 'Stop Bot' : 'Start Bot'
                  }
                </button>
                <button 
                  onClick={() => setIsSettingsOpen(true)}
                  className="flex items-center justify-center h-11 w-11 rounded-lg border border-[#514c3e] bg-[#37342a]/30 text-slate-300 hover:text-white transition-colors"
                >
                  <span className="material-symbols-outlined">settings</span>
                </button>
              </div>
            </section>

            <section className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <div className="flex flex-col gap-2 rounded-xl p-6 border border-[#514c3e] bg-[#37342a]/10">
                <div className="flex justify-between items-start">
                  <p className="text-slate-400 text-sm font-medium">Total Earned</p>
                  <span className="material-symbols-outlined text-[#d4af35]">payments</span>
                </div>
                <p className="text-white text-3xl font-bold font-display">{bot?.last_match?.price ? `€${bot.last_match.price}` : '€0.00'}</p>
                <div className="h-12 w-full mt-2 overflow-hidden">
                  <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 200 60">
                    <defs>
                      <linearGradient id="goldGradient" x1="0%" x2="0%" y1="0%" y2="100%">
                        <stop offset="0%" stopColor="#d4af35" stopOpacity="0.3"></stop>
                        <stop offset="100%" stopColor="#d4af35" stopOpacity="0"></stop>
                      </linearGradient>
                    </defs>
                    <path d="M0 60 Q 25 40, 50 45 T 100 20 T 150 35 T 200 10 V 60 H 0 Z" fill="url(#goldGradient)"></path>
                    <path d="M0 60 Q 25 40, 50 45 T 100 20 T 150 35 T 200 10" fill="none" stroke="#d4af35" strokeWidth="1.5"></path>
                  </svg>
                </div>
                <p className="text-emerald-400 text-xs font-medium flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">trending_up</span>
                  +12% from last week
                </p>
              </div>
              <div className="flex flex-col gap-2 rounded-xl p-6 border border-[#514c3e] bg-[#37342a]/10">
                <div className="flex justify-between items-start">
                  <p className="text-slate-400 text-sm font-medium">Last Ride Sniped</p>
                  <span className="material-symbols-outlined text-[#d4af35]">target</span>
                </div>
                <p className="text-white text-3xl font-bold font-display">{bot?.last_match ? '1' : '0'}</p>
                <p className="text-emerald-400 text-xs font-medium flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">check_circle</span>
                  {bot?.last_match ? `ID: ${bot.last_match.offer_id}` : 'No recent activity'}
                </p>
              </div>
              <div className="flex flex-col gap-2 rounded-xl p-6 border border-[#514c3e] bg-[#37342a]/10">
                <div className="flex justify-between items-start">
                  <p className="text-slate-400 text-sm font-medium">System status</p>
                  <span className="material-symbols-outlined text-rose-400">error_outline</span>
                </div>
                <p className="text-white text-3xl font-bold font-display">OK</p>
                <p className="text-emerald-400 text-xs font-medium flex items-center gap-1">
                  <span className="material-symbols-outlined text-xs">info</span>
                  All modules operational
                </p>
              </div>
            </section>

            {/* Bot-specific live log */}
            <div className="mb-10">
              <LiveSnipeLog mode="bot" botId={id} />
            </div>

            <div className="grid grid-cols-1 gap-8 items-start">
              <div className="lg:col-span-12 flex flex-col gap-8">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Price & Distance Range */}
                  <div className="bg-[#37342a]/10 border border-[#514c3e] rounded-xl p-8 backdrop-blur-xl bg-[#37342a]/20 shadow-2xl border-white/5 space-y-8">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="text-white text-2xl font-bold font-display">$</span>
                        <h3 className="text-white text-xl font-bold font-display">Price & Distance Range</h3>
                      </div>
                      <p className="text-slate-400 text-sm mt-1">Set minimum and maximum thresholds for ride price and distance</p>
                    </div>

                    {/* Price Section */}
                    <div className="space-y-6">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-bold text-lg">Price</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-bold text-sm">€{minPrice} - €{maxPrice}</span>
                          <span className="text-slate-500 text-xs font-medium">(€0 - €2000)</span>
                        </div>
                      </div>

                      <div className="relative h-6 flex items-center">
                        {/* Background track */}
                        <div className="absolute w-full h-1 bg-[#2a2820] rounded-full"></div>

                        {/* Selected range track */}
                        <div
                          className="absolute h-1 bg-gradient-to-r from-[#d4af35] to-[#f59e0b] rounded-full shadow-[0_0_15px_rgba(212,175,53,0.3)]"
                          style={{
                            left: `${(minPrice / 2000) * 100}%`,
                            right: `${100 - (maxPrice / 2000) * 100}%`
                          }}
                        ></div>

                        {/* Min Thumb Control */}
                        <input
                          type="range"
                          min="0"
                          max="2000"
                          value={minPrice}
                          onChange={(e) => {
                            setIsDirty(true);
                            setMinPrice(Math.min(Number(e.target.value), maxPrice));
                          }}
                          className={`absolute w-full appearance-none bg-transparent pointer-events-none h-1 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#d4af35] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg ${minPrice > 1000 ? 'z-30' : 'z-20'}`}
                        />

                        {/* Max Thumb Control */}
                        <input
                          type="range"
                          min="0"
                          max="2000"
                          value={maxPrice}
                          onChange={(e) => {
                            setIsDirty(true);
                            setMaxPrice(Math.max(Number(e.target.value), minPrice));
                          }}
                          className="absolute w-full appearance-none bg-transparent pointer-events-none z-20 h-1 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#d4af35] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                        />
                      </div>
                    </div>

                    <div className="w-full h-px bg-[#514c3e]/30"></div>

                    {/* Distance Section */}
                    <div className="space-y-6">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className="material-symbols-outlined text-white text-xl">location_on</span>
                          <span className="text-white font-bold text-lg">Distance</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-white font-bold text-sm">{minDistance} km - {maxDistance} km</span>
                          <span className="text-slate-500 text-xs font-medium">(0 - 1000 km)</span>
                        </div>
                      </div>

                      <div className="relative h-6 flex items-center">
                        {/* Background track */}
                        <div className="absolute w-full h-1 bg-[#2a2820] rounded-full"></div>

                        {/* Selected range track */}
                        <div
                          className="absolute h-1 bg-gradient-to-r from-[#d4af35] to-[#f59e0b] rounded-full shadow-[0_0_15px_rgba(212,175,53,0.3)]"
                          style={{
                            left: `${(minDistance / 1000) * 100}%`,
                            right: `${100 - (maxDistance / 1000) * 100}%`
                          }}
                        ></div>

                        {/* Min Thumb Control */}
                        <input
                          type="range"
                          min="0"
                          max="1000"
                          value={minDistance}
                          onChange={(e) => {
                            setIsDirty(true);
                            setMinDistance(Math.min(Number(e.target.value), maxDistance));
                          }}
                          className={`absolute w-full appearance-none bg-transparent pointer-events-none h-1 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#d4af35] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg ${minDistance > 500 ? 'z-30' : 'z-20'}`}
                        />

                        {/* Max Thumb Control */}
                        <input
                          type="range"
                          min="0"
                          max="1000"
                          value={maxDistance}
                          onChange={(e) => {
                            setIsDirty(true);
                            setMaxDistance(Math.max(Number(e.target.value), minDistance));
                          }}
                          className="absolute w-full appearance-none bg-transparent pointer-events-none z-20 h-1 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-black [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#d4af35] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Operational Hours & Timezone */}
                  <div className="bg-[#37342a]/10 border border-[#514c3e] rounded-xl p-8 backdrop-blur-xl bg-[#37342a]/20 shadow-2xl border-white/5 space-y-8">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-[#d4af35] text-2xl">public</span>
                        <h3 className="text-white text-xl font-bold font-display">Time Management</h3>
                      </div>
                      <p className="text-slate-400 text-sm mt-1">Configure when the bot is allowed to accept new rides.</p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Start Hour</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-sm">schedule</span>
                          <input
                            type="time"
                            step="3600"
                            value={`${workingHours.start.toString().padStart(2, '0')}:00`}
                            onChange={(e) => {
                              const hour = parseInt(e.target.value.split(':')[0]);
                              if (!isNaN(hour)) {
                                setIsDirty(true);
                                setWorkingHours({ ...workingHours, start: hour });
                              }
                            }}
                            className="w-full bg-[#171612] border border-[#514c3e] rounded-lg pl-10 pr-4 py-2 text-sm text-white outline-none focus:border-[#d4af35]"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">End Hour</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-sm">more_time</span>
                          <input
                            type="time"
                            step="3600"
                            value={`${workingHours.end.toString().padStart(2, '0')}:00`}
                            onChange={(e) => {
                              const hour = parseInt(e.target.value.split(':')[0]);
                              if (!isNaN(hour)) {
                                setIsDirty(true);
                                setWorkingHours({ ...workingHours, end: hour });
                              }
                            }}
                            className="w-full bg-[#171612] border border-[#514c3e] rounded-lg pl-10 pr-4 py-2 text-sm text-white outline-none focus:border-[#d4af35]"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Base Timezone</label>
                      <select
                        value={timezone}
                        onChange={(e) => {
                          setIsDirty(true);
                          setTimezone(e.target.value);
                        }}
                        className="w-full bg-[#171612] border border-[#514c3e] rounded-lg px-4 py-2.5 text-sm text-white outline-none focus:border-[#d4af35]"
                      >
                        <option value="Europe/Paris">Europe/Paris (GMT+1)</option>
                        <option value="Europe/London">Europe/London (GMT)</option>
                        <option value="America/New_York">America/New_York (GMT-5)</option>
                        <option value="Asia/Dubai">Asia/Dubai (GMT+4)</option>
                        <option value="Asia/Tokyo">Asia/Tokyo (GMT+9)</option>
                      </select>
                      <p className="text-[10px] text-slate-500 italic mt-1">Times above will be interpreted in this timezone.</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Minimum Time Gap */}
                  <div className="bg-[#37342a]/10 border border-[#514c3e] rounded-xl p-6 backdrop-blur-xl bg-[#37342a]/20 shadow-2xl border-white/5">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="material-symbols-outlined text-[#d4af35]">schedule</span>
                      <h3 className="text-white text-lg font-bold">Minimum Time Gap</h3>
                    </div>
                    <p className="text-slate-400 text-xs mb-6">Choose how many minutes the bot must wait between accepting two rides.</p>
                    <div className="space-y-6">
                      <div className="flex justify-between items-center">
                        <label className="text-sm font-semibold text-white">Time Gap (Minutes)</label>
                        <span className="text-sm font-bold text-white">{minGapMinutes} minutes</span>
                      </div>
                      <input
                        className="w-full accent-[#d4af35] bg-[#514c3e] h-1.5 rounded-lg appearance-none cursor-pointer"
                        max="240" min="0" type="range"
                        value={minGapMinutes}
                        onChange={(e) => {
                          setIsDirty(true);
                          setMinGapMinutes(Number(e.target.value));
                        }}
                      />
                      <div className="flex justify-between text-[10px] text-slate-500">
                        <span>0m</span><span>60m</span><span>120m</span><span>180m</span><span>240m</span>
                      </div>
                      <div className="w-full h-px bg-[#514c3e]/20 my-2"></div>

                      <div className="space-y-6">
                        <div className="flex justify-between items-center">
                          <label className="text-sm font-semibold text-white">Minimum Lead Time (Hours)</label>
                          <span className="text-sm font-bold text-[#d4af35]">{minLeadHours} hours</span>
                        </div>
                        <p className="text-slate-400 text-[10px] -mt-4">Only accept rides that start at least {minLeadHours}h from now (Blacklane cancellation safety).</p>
                        <input
                          className="w-full accent-[#d4af35] bg-[#514c3e] h-1.5 rounded-lg appearance-none cursor-pointer"
                          max="72" min="0" type="range"
                          value={minLeadHours}
                          onChange={(e) => {
                            setIsDirty(true);
                            setMinLeadHours(Number(e.target.value));
                          }}
                        />
                        <div className="flex justify-between text-[10px] text-slate-500">
                          <span>0h</span><span>24h</span><span>32h</span><span>48h</span><span>72h</span>
                        </div>
                      </div>

                      <div className="bg-[#171612]/50 border border-white/5 rounded-lg p-4">
                        <p className="text-xs text-slate-300 leading-relaxed">
                          <strong className="text-[#d4af35]">Cancellation Guard:</strong> Blacklane allows free cancellations if the ride is {'>'}24h away. This filter ensures you stay within that safety window.
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-8">
                    {/* Ride Preferences */}
                    <div className="bg-[#37342a]/10 border border-[#514c3e] rounded-xl p-6 backdrop-blur-xl bg-[#37342a]/20 shadow-2xl border-white/5">
                      <div className="flex items-center gap-2 mb-6">
                        <span className="material-symbols-outlined text-[#d4af35]">directions_car</span>
                        <h3 className="text-white text-lg font-bold">Ride Preferences</h3>
                      </div>
                      <div className="grid grid-cols-1 gap-6">
                        <div className="flex flex-col gap-2">
                          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Ride Type</label>
                          <select
                            value={rideType}
                            onChange={(e) => {
                              setIsDirty(true);
                              setRideType(e.target.value);
                            }}
                            className="w-full bg-[#171612] border border-[#514c3e] rounded-lg px-4 py-2 text-white focus:border-[#d4af35] outline-none"
                          >
                            <option>Both</option>
                            <option>Transfer</option>
                            <option>Hourly</option>
                          </select>
                        </div>
                        <div className="flex flex-col gap-3">
                          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Vehicle Class</label>
                          <div className="grid grid-cols-2 gap-3">
                            {[
                              { id: 'business', label: 'Business', icon: 'business_center' },
                              { id: 'van', label: 'Van', icon: 'airport_shuttle' },
                              { id: 'electric', label: 'Electric', icon: 'electric_car' },
                              { id: 'first', label: 'First', icon: 'diamond' }
                            ].map((v) => (
                              <div
                                key={v.id}
                                onClick={() => toggleVehicleClass(v.id)}
                                className={`flex items-center gap-3 p-3 rounded-lg border transition-all cursor-pointer group ${vehicleClasses.includes(v.id) ? 'bg-[#d4af35]/10 border-[#d4af35]' : 'bg-[#171612]/50 border-[#514c3e] hover:border-[#d4af35]'}`}
                              >
                                <div className={`size-4 border rounded flex items-center justify-center ${vehicleClasses.includes(v.id) ? 'border-[#d4af35]' : 'border-[#514c3e] group-hover:border-[#d4af35]'}`}>
                                  <div className={`size-2 bg-[#d4af35] rounded-sm ${vehicleClasses.includes(v.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}></div>
                                </div>
                                <span className={`material-symbols-outlined text-lg ${vehicleClasses.includes(v.id) ? 'text-[#d4af35]' : 'text-slate-400 group-hover:text-[#d4af35]'}`}>{v.icon}</span>
                                <span className={`text-xs font-bold uppercase ${vehicleClasses.includes(v.id) ? 'text-[#d4af35]' : 'text-slate-300'}`}>{v.label}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Include Pickup Airline Codes */}
                <div className="bg-[#37342a]/10 border border-[#514c3e] rounded-xl p-6 backdrop-blur-xl bg-[#37342a]/20 shadow-2xl border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-[#d4af35]">flight_takeoff</span>
                    <h3 className="text-white text-lg font-bold">Include Pickup Airline Codes</h3>
                  </div>
                  <p className="text-slate-400 text-xs mb-6">The bot will ONLY accept rides for these codes (leave empty for all).</p>
                  <div className="space-y-4">
                    <div className="flex flex-col gap-2">
                      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Add Airline Code</label>
                      <form onSubmit={(e) => { e.preventDefault(); addAirline(); }} className="flex gap-2">
                        <input
                          value={airlineCode}
                          onChange={(e) => setAirlineCode(e.target.value)}
                          className="flex-1 bg-[#171612] border border-[#514c3e] rounded-lg px-4 py-2 text-sm text-white outline-none focus:border-[#d4af35]"
                          placeholder="Enter code (e.g., EK, AT, LH)" type="text"
                        />
                        <button type="submit" className="px-4 py-2 bg-[#37342a]/50 border border-[#514c3e] rounded-lg text-sm font-bold text-slate-300 hover:bg-[#37342a]">Add</button>
                      </form>
                    </div>
                    {includedAirlines.length === 0 ? (
                      <div className="p-6 border border-dashed border-[#514c3e] rounded-lg text-center">
                        <p className="text-xs text-slate-500 italic">No airline codes included. Bot will check all airlines.</p>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {includedAirlines.map(code => (
                          <div key={code} className="flex items-center gap-2 px-3 py-1 bg-[#171612] border border-[#514c3e] rounded-lg text-xs">
                            <span className="font-bold text-slate-200">{code}</span>
                            <button onClick={() => removeAirline(code)} className="material-symbols-outlined text-sm text-slate-500 hover:text-rose-400">close</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Zip Code Management */}
                <div className="bg-[#37342a]/10 border border-[#514c3e] rounded-xl p-6 backdrop-blur-xl bg-[#37342a]/20 shadow-2xl border-white/5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="material-symbols-outlined text-[#d4af35]">pincode</span>
                    <h3 className="text-white text-lg font-bold">Zip Code Management</h3>
                  </div>
                  <p className="text-slate-400 text-xs mb-8">Whitelist or blacklist offers based on pickup or drop-off zip codes.</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <label className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
                        <span className="material-symbols-outlined text-sm">verified</span>
                        Allowed Zip Codes (Whitelist)
                      </label>
                      <form onSubmit={(e) => { e.preventDefault(); addZipCodeAccept(); }} className="flex gap-2">
                        <input
                          value={zipCodeInputAccept}
                          onChange={(e) => setZipCodeInputAccept(e.target.value)}
                          className="flex-1 bg-[#171612] border border-[#514c3e] rounded-lg px-4 py-2 text-sm text-white outline-none focus:border-[#d4af35]"
                          placeholder="Enter zip code" type="text"
                        />
                        <button type="submit" className="px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-sm font-bold text-emerald-400 hover:bg-emerald-500/20">Add</button>
                      </form>
                      {allowedZipCodes.length === 0 ? (
                        <div className="p-6 border border-dashed border-[#514c3e] rounded-lg text-center">
                          <p className="text-xs text-slate-500 italic">No zip codes whitelisted.</p>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {allowedZipCodes.map(code => (
                            <div key={code} className="flex items-center gap-2 px-3 py-1 bg-[#171612] border border-emerald-500/20 rounded-lg text-xs">
                              <span className="text-emerald-400 font-medium">{code}</span>
                              <button onClick={() => removeZipCodeAccept(code)} className="material-symbols-outlined text-sm text-slate-500 hover:text-rose-400">close</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="space-y-4">
                      <label className="text-sm font-semibold text-rose-400 flex items-center gap-2">
                        <span className="material-symbols-outlined text-sm">block</span>
                        Blocked Zip Codes (Blacklist)
                      </label>
                      <form onSubmit={(e) => { e.preventDefault(); addZipCodeBlock(); }} className="flex gap-2">
                        <input
                          value={zipCodeInputBlock}
                          onChange={(e) => setZipCodeInputBlock(e.target.value)}
                          className="flex-1 bg-[#171612] border border-[#514c3e] rounded-lg px-4 py-2 text-sm text-white outline-none focus:border-[#rose-400]"
                          placeholder="Enter zip code" type="text"
                        />
                        <button type="submit" className="px-4 py-2 bg-rose-500/10 border border-rose-500/20 rounded-lg text-sm font-bold text-rose-400 hover:bg-rose-500/20">Block</button>
                      </form>
                      {blockedZipCodes.length === 0 ? (
                        <div className="p-6 border border-dashed border-[#514c3e] rounded-lg text-center">
                          <p className="text-xs text-slate-500 italic">No zip codes blacklisted.</p>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {blockedZipCodes.map(code => (
                            <div key={code} className="flex items-center gap-2 px-3 py-1 bg-[#171612] border border-rose-500/20 rounded-lg text-xs">
                              <span className="text-rose-400 font-medium">{code}</span>
                              <button onClick={() => removeZipCodeBlock(code)} className="material-symbols-outlined text-sm text-slate-500 hover:text-rose-400">close</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Final Actions */}
                <div className="flex items-center justify-end gap-6 h-12">
                  {showSuccess && (
                    <div className="flex items-center gap-2 text-emerald-400 font-bold animate-in fade-in slide-in-from-right-4 duration-500">
                      <span className="material-symbols-outlined text-xl">check_circle</span>
                      <span>Changes saved successfully!</span>
                    </div>
                  )}
                  
                  {isDirty && (
                    <div className="flex items-center gap-4 animate-in fade-in zoom-in duration-300">
                      <button 
                        onClick={() => window.location.reload()}
                        className="px-6 py-2 text-slate-400 font-semibold hover:text-white transition-colors"
                      >
                        Discard
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-10 py-3 bg-gradient-to-br from-[#e5c76b] to-[#b8952b] text-[#171612] font-extrabold rounded-lg shadow-[0_8px_30px_rgb(212,175,53,0.3)] hover:scale-[1.02] active:scale-95 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="material-symbols-outlined">{saving ? 'sync' : 'save'}</span>
                        {saving ? 'Saving...' : 'Save All Filter Rules'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </main>
          
          <footer className="mt-auto border-t border-[#514c3e] py-6 px-10 text-center">
            <p className="text-slate-500 text-xs">© 2024 ChauffeurBot Systems. All automated activities logged for compliance.</p>
          </footer>

          {/* Settings Modal */}
          {isSettingsOpen && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-300">
              {/* Backdrop */}
              <div 
                className="absolute inset-0 bg-black/80 backdrop-blur-md"
                onClick={() => setIsSettingsOpen(false)}
              ></div>
              
              {/* Modal Content */}
              <div className="relative w-full max-w-xl bg-[#171612] border border-[#514c3e] rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-300">
                <div className="flex items-center justify-between p-6 border-b border-[#514c3e]">
                  <div className="flex items-center gap-3">
                    <span className="material-symbols-outlined text-[#d4af35]">settings</span>
                    <h3 className="text-xl font-bold text-white">Account Settings</h3>
                  </div>
                  <button 
                    onClick={() => setIsSettingsOpen(false)}
                    className="size-8 flex items-center justify-center rounded-lg hover:bg-[#37342a] text-slate-400 transition-colors"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
                
                <div className="p-8 space-y-6">
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Account Name</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-sm">badge</span>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full bg-[#171612] border border-[#514c3e] rounded-lg pl-10 pr-4 py-3 text-white outline-none focus:border-[#d4af35] transition-all"
                        placeholder="My Business Bot"
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Blacklane Email</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-sm">mail</span>
                      <input
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        className="w-full bg-[#171612] border border-[#514c3e] rounded-lg pl-10 pr-4 py-3 text-white outline-none focus:border-[#d4af35] transition-all"
                        placeholder="email@example.com"
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">New Password</label>
                      <span className="text-[10px] text-slate-500 italic">Leave empty to keep existing</span>
                    </div>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-sm">lock</span>
                      <input
                        type="password"
                        value={editPassword}
                        onChange={(e) => setEditPassword(e.target.value)}
                        className="w-full bg-[#171612] border border-[#514c3e] rounded-lg pl-10 pr-4 py-3 text-white outline-none focus:border-[#d4af35] transition-all"
                        placeholder="••••••••••••"
                      />
                    </div>
                  </div>

                  <div className="pt-4 flex gap-4">
                    <button
                      onClick={() => setIsSettingsOpen(false)}
                      className="flex-1 px-6 py-3 border border-[#514c3e] text-slate-300 font-bold rounded-lg hover:bg-[#37342a] transition-all"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleUpdateAccount}
                      disabled={updatingAccount}
                      className="flex-[2] px-6 py-3 bg-gradient-to-br from-[#e5c76b] to-[#b8952b] text-[#171612] font-extrabold rounded-lg shadow-lg hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {updatingAccount ? (
                        <>
                          <span className="material-symbols-outlined animate-spin text-lg">sync</span>
                          Saving Changes...
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined text-lg">check</span>
                          Update Account
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
