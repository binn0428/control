import React, { useEffect, useState } from "react";
import {
  MapContainer, TileLayer, Circle, Marker,
  useMap, useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import {
  Crosshair, ChevronLeft, ChevronRight,
  LogOut, Settings, Share2, Trash2,
} from "lucide-react";
import { supabase } from "../utils/supabaseClient";
import { connectMqtt, publishMqtt, disconnectMqtt } from "../utils/mqttClient";

// 修正 Leaflet marker icon 在 Vite 的路徑問題
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/* ─── 型別 ──────────────────────────────────────────── */
interface DeviceCredential {
  id: string;
  device_name: string;
  mqtt_user?: string;
  mqtt_pass?: string;
  share_from?: string | null;   // null = 自己的設備; 有值 = 分享而來
  count?: number;               // 已分享次數
}

interface SavedLocation {
  id: string;
  label: string;
  position: [number, number];
}

/* ─── 地圖子元件 ─────────────────────────────────────── */

// 飛移到指定座標
function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, 18, { duration: 1.2 });
  }, [target, map]);
  return null;
}

// 點擊地圖設定 pending location
function MapClickHandler({ onMapClick }: { onMapClick: (pos: [number, number]) => void }) {
  useMapEvents({ click: (e) => onMapClick([e.latlng.lat, e.latlng.lng]) });
  return null;
}

/* ─── 主元件 ─────────────────────────────────────────── */
const MAX_SHARES = 5;
const DEFAULT_CENTER: [number, number] = [22.6273, 120.3014]; // 高雄

export default function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  /* 設備 */
  const [devices, setDevices] = useState<DeviceCredential[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceCredential | null>(null);
  const [loading, setLoading] = useState(true);
  const [mqttStatus, setMqttStatus] = useState("Disconnected");
  const [showCredentials, setShowCredentials] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  /* 地圖 */
  const [isStreetView, setIsStreetView] = useState(false);
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [pendingLocation, setPendingLocation] = useState<[number, number] | null>(null);
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>([]);
  const [activeLocIdx, setActiveLocIdx] = useState(0);

  /* 分享剩餘：選中設備若 share_from=null 才顯示 */
  const isOwnDevice = selectedDevice && !selectedDevice.share_from;
  const shareRemaining = isOwnDevice ? MAX_SHARES - (selectedDevice!.count ?? 0) : null;

  /* ── 取得設備清單 ── */
  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase
          .from("device_credentials")
          .select("*")
          .eq("user_id", email);
        if (error) throw error;
        setDevices(data || []);
        if (data && data.length > 0) setSelectedDevice(data[0]);
      } catch (err) {
        console.error("fetchDevices:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [email]);

  /* ── MQTT 連線 ── */
  useEffect(() => {
    if (!selectedDevice?.mqtt_user || !selectedDevice?.mqtt_pass) return;
    setMqttStatus("Connecting...");
    const client = connectMqtt(
      "wss://8141bbadc4214f9d9f30e7822bd41522.s1.eu.hivemq.cloud:8884/mqtt",
      {
        username: selectedDevice.mqtt_user,
        password: selectedDevice.mqtt_pass,
        clientId: `web_${Math.random().toString(36).slice(2, 9)}`,
      }
    );
    client.on("connect", () => setMqttStatus("Connected"));
    client.on("error",   () => setMqttStatus("Error"));
    client.on("close",   () => setMqttStatus("Disconnected"));
    return () => { disconnectMqtt(); };
  }, [selectedDevice]);

  /* ── 登出 ── */
  const handleLogout = async () => {
    try {
      await supabase.from("registered_emails").update({ mac: null }).eq("email", email);
      await supabase.auth.signOut();
      onLogout();
    } catch (err) { console.error("logout:", err); }
  };

  /* ── 重置 ── */
  const handleReset = async () => {
    setResetting(true);
    try {
      const { error } = await supabase.from("device_credentials").delete().eq("user_id", email);
      if (error) throw error;
      setDevices([]);
      setSelectedDevice(null);
      setShowResetConfirm(false);
      alert("重置完成，設備資料已清除。");
    } catch (err) {
      console.error("reset:", err);
      alert("重置失敗，請稍後再試。");
    } finally { setResetting(false); }
  };

  /* ── MQTT 控制 ── */
  const handleControl = (action: string) => {
    if (!selectedDevice?.mqtt_user || !selectedDevice?.device_name) {
      alert("請先選擇設備或確保設備帳密設定正確"); return;
    }
    const topic = `device/${selectedDevice.mqtt_user}/${selectedDevice.device_name}/command`;
    const pin = action === "open" ? "D4" : action === "stop" ? "D18" : "D19";
    publishMqtt(topic, JSON.stringify({ action, pin, ts: Math.floor(Date.now() / 1000) }));
  };

  /* ── GPS 定位 ── */
  const handleLocate = () => {
    if (!navigator.geolocation) { setGpsError("此瀏覽器不支援 GPS 定位"); return; }
    setGpsLoading(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setUserPosition(coords);
        setFlyTarget(coords);
        setGpsError(null);   // ← 確保成功時清除錯誤
        setGpsLoading(false);
      },
      (err) => {
        setGpsLoading(false);
        setGpsError(
          err.code === err.PERMISSION_DENIED
            ? "GPS 定位權限被拒絕，請在瀏覽器設定中允許定位。"
            : "無法取得位置，請稍後再試。"
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  /* ── 地圖點擊 ── */
  const handleMapClick = (pos: [number, number]) => setPendingLocation(pos);

  /* ── 新增地點 ── */
  const handleAddLocation = () => {
    if (!pendingLocation) return;
    const newLoc: SavedLocation = {
      id: Date.now().toString(),
      label: `地點 ${savedLocations.length + 1}`,
      position: pendingLocation,
    };
    const updated = [...savedLocations, newLoc];
    setSavedLocations(updated);
    setActiveLocIdx(updated.length - 1);
    setPendingLocation(null);
  };

  /* ── 地點導航 ── */
  const handlePrevLoc = () => {
    if (!savedLocations.length) return;
    const idx = (activeLocIdx - 1 + savedLocations.length) % savedLocations.length;
    setActiveLocIdx(idx);
    setFlyTarget(savedLocations[idx].position);
  };
  const handleNextLoc = () => {
    if (!savedLocations.length) return;
    const idx = (activeLocIdx + 1) % savedLocations.length;
    setActiveLocIdx(idx);
    setFlyTarget(savedLocations[idx].position);
  };

  /* ── Loading ── */
  if (loading) return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center text-white">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  /* ═══════════════════════════════════════════ RENDER ══ */
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-10 font-sans">

      {/* ── Header ── */}
      <div className="p-4 pt-8">
        <div className="flex justify-between items-end mb-1">
          <h1 className="text-3xl font-bold tracking-tight">Smart Lock</h1>
          {/* 分享剩餘：只有自己的設備（share_from=null）才有剩餘次數 */}
          {shareRemaining !== null ? (
            <span className={`text-sm font-medium ${shareRemaining > 0 ? "text-slate-400" : "text-red-400"}`}>
              分享剩餘：{shareRemaining}/{MAX_SHARES}
            </span>
          ) : (
            <span className="text-xs text-slate-500 bg-slate-800 px-3 py-1 rounded-full">
              共享設備・不可再分享
            </span>
          )}
        </div>
        <p className="text-slate-400 text-lg mb-4">控制面板</p>

        {/* 設備清單（含分享/刪除圖示） */}
        <div className="space-y-2 mb-4">
          {devices.length === 0 && (
            <p className="text-slate-500 text-sm px-1">尚無設備，請完成設備配對。</p>
          )}
          {devices.map((dev) => {
            const own = !dev.share_from;
            const active = selectedDevice?.id === dev.id;
            return (
              <div
                key={dev.id}
                onClick={() => setSelectedDevice(dev)}
                className={`flex items-center justify-between px-4 py-3 rounded-xl border cursor-pointer transition-colors select-none ${
                  active ? "border-blue-500 bg-blue-500/10" : "border-slate-700 bg-slate-800 hover:border-slate-600"
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${own ? "bg-green-500" : "bg-yellow-500"}`} />
                  <span className="font-medium">{dev.device_name}</span>
                  {!own && (
                    <span className="text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-600/30 px-2 py-0.5 rounded-full">
                      共享
                    </span>
                  )}
                </div>
                {/* 只有自己的設備才顯示分享 & 刪除按鈕 */}
                {own && (
                  <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="p-2 rounded-lg text-blue-400 hover:bg-blue-500/20 transition-colors"
                      title="分享設備"
                      onClick={() => alert(`即將分享：${dev.device_name}`)}
                    >
                      <Share2 className="w-4 h-4" />
                    </button>
                    <button
                      className="p-2 rounded-lg text-red-400 hover:bg-red-500/20 transition-colors"
                      title="刪除設備"
                      onClick={async () => {
                        if (!confirm(`確定刪除設備「${dev.device_name}」？`)) return;
                        await supabase.from("device_credentials").delete().eq("id", dev.id);
                        const updated = devices.filter((d) => d.id !== dev.id);
                        setDevices(updated);
                        if (selectedDevice?.id === dev.id) setSelectedDevice(updated[0] ?? null);
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 操作按鈕列 */}
        <div className="flex items-center gap-3 mb-6 flex-wrap">
          <button
            onClick={() => setShowResetConfirm(true)}
            className="bg-red-500 hover:bg-red-600 text-white px-5 py-2.5 rounded-full font-medium transition-colors"
          >
            重置
          </button>
          <button
            onClick={() => setShowCredentials(true)}
            className="bg-blue-500 hover:bg-blue-600 text-white px-5 py-2.5 rounded-full font-medium transition-colors flex items-center gap-2"
          >
            <Settings className="w-4 h-4" /> 設備帳密
          </button>
          <button
            onClick={handleLogout}
            className="text-slate-500 hover:text-white p-2 ml-auto"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>

        {/* 連線狀態 */}
        <div className="mb-4 flex items-center gap-2 text-sm">
          <div className={`w-2 h-2 rounded-full ${
            mqttStatus === "Connected" ? "bg-green-500" :
            mqttStatus === "Connecting..." ? "bg-yellow-500 animate-pulse" : "bg-red-500"
          }`} />
          <span className="text-slate-400">狀態: {mqttStatus}</span>
        </div>
      </div>

      {/* ── 地圖區塊 ── */}
      <div className="bg-slate-900 mx-4 rounded-2xl overflow-hidden border border-slate-800 mb-4">
        <div className="p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold">新增地點地圖</h2>
          <div className="flex gap-2">
            {/* 切換衛星／街道圖 */}
            <button
              onClick={() => setIsStreetView((v) => !v)}
              className={`px-4 py-2 rounded-full border text-sm font-medium transition-colors ${
                isStreetView
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300"
              }`}
            >
              {isStreetView ? "街道圖" : "衛星圖"}
            </button>
            {/* 上一個地點 */}
            <button
              onClick={handlePrevLoc}
              disabled={savedLocations.length === 0}
              className="bg-slate-800 hover:bg-slate-700 p-2 rounded-full border border-slate-700 w-10 h-10 flex items-center justify-center disabled:opacity-30 transition-colors"
              title="上一個地點"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            {/* 下一個地點 */}
            <button
              onClick={handleNextLoc}
              disabled={savedLocations.length === 0}
              className="bg-slate-800 hover:bg-slate-700 p-2 rounded-full border border-slate-700 w-10 h-10 flex items-center justify-center disabled:opacity-30 transition-colors"
              title="下一個地點"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            {/* GPS 定位 */}
            <button
              onClick={handleLocate}
              disabled={gpsLoading}
              className={`p-2 rounded-full border w-10 h-10 flex items-center justify-center transition-colors ${
                gpsLoading  ? "bg-yellow-500/20 border-yellow-500 text-yellow-400" :
                userPosition ? "bg-green-500/20 border-green-500 text-green-400" :
                               "bg-slate-800 hover:bg-slate-700 border-slate-700"
              }`}
              title="GPS 定位"
            >
              {gpsLoading
                ? <div className="w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                : <Crosshair className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* GPS 錯誤提示（有錯誤且尚未定位成功時才顯示） */}
        {gpsError && !userPosition && (
          <p className="px-4 pb-2 text-red-400 text-xs">{gpsError}</p>
        )}

        {/* 提示文字 */}
        <p className="px-4 pb-3 text-slate-400 text-sm">
          {pendingLocation
            ? `📍 已選取：${pendingLocation[0].toFixed(5)}, ${pendingLocation[1].toFixed(5)}，按「新增地點」儲存`
            : userPosition
            ? `✅ GPS 定位成功：${userPosition[0].toFixed(5)}, ${userPosition[1].toFixed(5)}`
            : "點擊地圖選取位置，或按 ⊕ GPS 定位"}
        </p>

        {/* Leaflet Map */}
        <div className="h-72 w-full">
          <MapContainer
            center={userPosition || DEFAULT_CENTER}
            zoom={17}
            maxZoom={22}
            style={{ height: "100%", width: "100%" }}
            zoomControl
          >
            {/* 圖層切換 */}
            {isStreetView ? (
              <TileLayer
                key="street"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap"
                maxZoom={22}
                maxNativeZoom={19}
              />
            ) : (
              <TileLayer
                key="satellite"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="Tiles &copy; Esri"
                maxZoom={22}
                maxNativeZoom={20}
              />
            )}

            <FlyTo target={flyTarget} />
            <MapClickHandler onMapClick={handleMapClick} />

            {/* GPS 定位圓圈 + Marker */}
            {userPosition && (
              <>
                <Circle
                  center={userPosition}
                  radius={15}
                  pathOptions={{ fillColor: "#3b82f6", fillOpacity: 0.3, color: "#3b82f6", weight: 2 }}
                />
                <Marker position={userPosition} />
              </>
            )}

            {/* 點選地圖的 pending marker */}
            {pendingLocation && <Marker position={pendingLocation} />}

            {/* 已儲存的地點 */}
            {savedLocations.map((loc) => (
              <Marker key={loc.id} position={loc.position} />
            ))}
          </MapContainer>
        </div>

        {/* 地圖底部狀態列 */}
        <div className="p-4 border-t border-slate-800 flex items-center justify-between">
          <p className="text-slate-400 text-sm">
            {savedLocations.length > 0
              ? `${savedLocations[activeLocIdx]?.label}（${activeLocIdx + 1}/${savedLocations.length}）`
              : pendingLocation ? "已選取位置，可按「新增地點」儲存" : "尚未選取位置"}
          </p>
          {savedLocations.length > 0 && (
            <span className="text-xs text-slate-500">{savedLocations.length} 個地點</span>
          )}
        </div>
      </div>

      {/* ── 手動控制 ── */}
      <div className="bg-slate-900 mx-4 rounded-2xl p-4 border border-slate-800 mb-4">
        <h2 className="text-xl font-bold mb-4">手動控制</h2>
        <div className="grid grid-cols-3 gap-4">
          <button onClick={() => handleControl("open")}
            className="py-4 rounded-2xl border border-blue-500 text-blue-400 hover:bg-blue-500/10 font-bold text-lg transition-colors">開</button>
          <button onClick={() => handleControl("stop")}
            className="py-4 rounded-2xl border border-red-500 text-red-400 hover:bg-red-500/10 font-bold text-lg transition-colors">停</button>
          <button onClick={() => handleControl("down")}
            className="py-4 rounded-2xl border border-slate-600 text-slate-300 hover:bg-slate-800 font-bold text-lg transition-colors">關</button>
        </div>
      </div>

      {/* ── 位置設定 ── */}
      <div className="bg-slate-900 mx-4 rounded-2xl p-4 border border-slate-800">
        <h2 className="text-xl font-bold mb-4">位置設定</h2>
        <button
          onClick={handleAddLocation}
          disabled={!pendingLocation}
          className="w-full py-4 rounded-2xl border border-purple-600 bg-purple-900/20 text-white font-bold text-lg hover:bg-purple-900/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pendingLocation ? "✚ 新增地點" : "新增地點（請先點選地圖）"}
        </button>

        {/* 已儲存地點清單 */}
        {savedLocations.length > 0 && (
          <div className="mt-3 space-y-2">
            {savedLocations.map((loc, idx) => (
              <div
                key={loc.id}
                className={`flex items-center justify-between px-3 py-2.5 rounded-xl border transition-colors ${
                  idx === activeLocIdx ? "border-purple-500 bg-purple-500/10" : "border-slate-700 bg-slate-800"
                }`}
              >
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${idx === activeLocIdx ? "bg-purple-400" : "bg-slate-500"}`} />
                  <span className="text-sm text-slate-300">{loc.label}</span>
                  <span className="text-xs text-slate-500">
                    {loc.position[0].toFixed(4)}, {loc.position[1].toFixed(4)}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setActiveLocIdx(idx); setFlyTarget(loc.position); }}
                    className="text-xs text-blue-400 hover:text-blue-300 px-2 py-1"
                  >
                    前往
                  </button>
                  <button
                    onClick={() => {
                      const updated = savedLocations.filter((_, i) => i !== idx);
                      setSavedLocations(updated);
                      setActiveLocIdx(Math.min(activeLocIdx, Math.max(0, updated.length - 1)));
                    }}
                    className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
                  >
                    刪除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── 設備帳密 Modal ── */}
      {showCredentials && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-xl font-bold mb-4">設備帳密</h3>
            {selectedDevice ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">帳號</label>
                  <div className="bg-slate-800 p-3 rounded-xl font-mono text-sm border border-slate-700 break-all">
                    {selectedDevice.mqtt_user || "未設定"}
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">密碼</label>
                  <div className="bg-slate-800 p-3 rounded-xl font-mono text-sm border border-slate-700 break-all">
                    {selectedDevice.mqtt_pass || "未設定"}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-slate-400">請先選擇設備</p>
            )}
            <button
              onClick={() => setShowCredentials(false)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl mt-6 transition-colors"
            >
              關閉
            </button>
          </div>
        </div>
      )}

      {/* ── 重置確認 Modal ── */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-red-500/50 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-xl font-bold mb-2 text-red-400">確認重置</h3>
            <p className="text-slate-300 mb-1 text-sm">此操作將清除您帳號下所有設備資料。</p>
            <p className="text-slate-400 text-xs mb-6">⚠ 登入資格（registered_emails）不受影響，重置後仍可登入。</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowResetConfirm(false)}
                disabled={resetting}
                className="flex-1 py-3 rounded-xl border border-slate-600 text-slate-300 hover:bg-slate-800 font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleReset}
                disabled={resetting}
                className="flex-1 py-3 rounded-xl bg-red-600 hover:bg-red-700 text-white font-bold transition-colors flex items-center justify-center gap-2"
              >
                {resetting
                  ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  : "確認重置"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
