import React, { useEffect, useState, useRef } from "react";
import { MapContainer, TileLayer, Circle, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import {
  Crosshair,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Settings,
} from "lucide-react";
import { supabase } from "../utils/supabaseClient";
import { connectMqtt, publishMqtt, disconnectMqtt } from "../utils/mqttClient";

// 修正 Leaflet 預設 marker icon 在 Vite 的路徑問題
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

interface DeviceCredential {
  id: string;
  device_name: string;
  mqtt_user?: string;
  mqtt_pass?: string;
}

// 子元件：接收指令後移動地圖中心
function FlyToLocation({ position }: { position: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (position) {
      map.flyTo(position, 17, { duration: 1.2 });
    }
  }, [position, map]);
  return null;
}

export default function Dashboard({
  email,
  onLogout,
}: {
  email: string;
  onLogout: () => void;
}) {
  const [devices, setDevices] = useState<DeviceCredential[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceCredential | null>(null);
  const [loading, setLoading] = useState(true);
  const [mqttStatus, setMqttStatus] = useState("Disconnected");
  const [showCredentials, setShowCredentials] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);

  // 地圖相關
  const [isStreetView, setIsStreetView] = useState(false); // false = 衛星圖, true = 街道圖
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);

  const defaultCenter: [number, number] = [22.6273, 120.3014]; // 高雄

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const { data, error } = await supabase
          .from("device_credentials")
          .select("*")
          .eq("user_id", email);

        if (error) throw error;
        setDevices(data || []);
        if (data && data.length > 0) {
          setSelectedDevice(data[0]);
        }
      } catch (err) {
        console.error("Error fetching devices:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchDevices();
  }, [email]);

  useEffect(() => {
    if (selectedDevice?.mqtt_user && selectedDevice?.mqtt_pass) {
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
      client.on("error", () => setMqttStatus("Error"));
      client.on("close", () => setMqttStatus("Disconnected"));
      return () => { disconnectMqtt(); };
    }
  }, [selectedDevice]);

  const handleLogout = async () => {
    try {
      await supabase.from("registered_emails").update({ mac: null }).eq("email", email);
      await supabase.auth.signOut();
      onLogout();
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  // 重置：清除該帳號在 device_credentials 的資料（registered_emails 保留）
  const handleReset = async () => {
    setResetting(true);
    try {
      const { error } = await supabase
        .from("device_credentials")
        .delete()
        .eq("user_id", email);

      if (error) throw error;

      setDevices([]);
      setSelectedDevice(null);
      setShowResetConfirm(false);
      alert("重置完成，設備資料已清除。");
    } catch (err) {
      console.error("Reset error:", err);
      alert("重置失敗，請稍後再試。");
    } finally {
      setResetting(false);
    }
  };

  const handleControl = (action: string) => {
    if (selectedDevice?.mqtt_user && selectedDevice?.device_name) {
      const topicCmd = `device/${selectedDevice.mqtt_user}/${selectedDevice.device_name}/command`;
      let pin = "";
      if (action === "open") pin = "D4";
      else if (action === "stop") pin = "D18";
      else if (action === "down") pin = "D19";
      const message = JSON.stringify({ action, pin, ts: Math.floor(Date.now() / 1000) });
      publishMqtt(topicCmd, message);
    } else {
      alert("請先選擇設備或確保設備帳密設定正確");
    }
  };

  // GPS 定位
  const handleLocate = () => {
    if (!navigator.geolocation) {
      setGpsError("此瀏覽器不支援 GPS 定位");
      return;
    }
    setGpsLoading(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setUserPosition(coords);
        setFlyTarget(coords);
        setGpsLoading(false);
      },
      (err) => {
        setGpsLoading(false);
        if (err.code === err.PERMISSION_DENIED) {
          setGpsError("GPS 定位權限被拒絕，請在瀏覽器設定中允許定位。");
        } else {
          setGpsError("無法取得位置，請稍後再試。");
        }
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-white">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-10 font-sans">
      {/* Header */}
      <div className="p-4 pt-8">
        <div className="flex justify-between items-end mb-1">
          <h1 className="text-3xl font-bold tracking-tight">Smart Lock</h1>
          <span className="text-slate-400 text-sm">分享剩餘：4/5</span>
        </div>
        <p className="text-slate-400 text-lg mb-4">控制面板</p>

        <div className="flex items-center gap-3 mb-6">
          <select
            className="flex-1 bg-slate-800 border border-slate-700 text-white rounded-xl px-4 py-2.5 appearance-none focus:outline-none focus:border-slate-500"
            value={selectedDevice?.id || ""}
            onChange={(e) => {
              const device = devices.find((d) => d.id === e.target.value);
              setSelectedDevice(device || null);
            }}
          >
            {devices.length === 0 && <option value="">無設備</option>}
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.device_name}
              </option>
            ))}
          </select>
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
            <Settings className="w-4 h-4" />
            設備帳密
          </button>
          <button
            onClick={handleLogout}
            className="text-slate-500 hover:text-white p-2 flex items-center gap-1"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>

        {/* 連線狀態 */}
        <div className="mb-4 flex items-center gap-2 text-sm">
          <div
            className={`w-2 h-2 rounded-full ${
              mqttStatus === "Connected"
                ? "bg-green-500"
                : mqttStatus === "Connecting..."
                ? "bg-yellow-500"
                : "bg-red-500"
            }`}
          />
          <span className="text-slate-400">狀態: {mqttStatus}</span>
        </div>
      </div>

      {/* Map Section */}
      <div className="bg-slate-900 mx-4 rounded-2xl overflow-hidden border border-slate-800 mb-4">
        <div className="p-4 flex justify-between items-center">
          <h2 className="text-xl font-bold">新增地點地圖</h2>
          <div className="flex gap-2">
            {/* 切換：衛星圖 ↔ 街道圖 */}
            <button
              onClick={() => setIsStreetView((v) => !v)}
              className={`p-2 rounded-full border w-auto px-4 flex items-center gap-1 text-sm font-medium transition-colors ${
                isStreetView
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-800 hover:bg-slate-700 border-slate-700"
              }`}
            >
              {isStreetView ? "街道圖" : "衛星圖"}
            </button>
            <button className="bg-slate-800 hover:bg-slate-700 p-2 rounded-full border border-slate-700 w-10 h-10 flex items-center justify-center">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button className="bg-slate-800 hover:bg-slate-700 p-2 rounded-full border border-slate-700 w-10 h-10 flex items-center justify-center">
              <ChevronRight className="w-5 h-5" />
            </button>
            {/* GPS 定位按鈕 */}
            <button
              onClick={handleLocate}
              disabled={gpsLoading}
              className={`p-2 rounded-full border w-10 h-10 flex items-center justify-center transition-colors ${
                gpsLoading
                  ? "bg-yellow-500/20 border-yellow-500 text-yellow-400"
                  : userPosition
                  ? "bg-green-500/20 border-green-500 text-green-400"
                  : "bg-slate-800 hover:bg-slate-700 border-slate-700"
              }`}
              title="定位我的位置"
            >
              {gpsLoading ? (
                <div className="w-4 h-4 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
              ) : (
                <Crosshair className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>

        {gpsError && (
          <p className="px-4 pb-2 text-red-400 text-xs">{gpsError}</p>
        )}
        <p className="px-4 pb-3 text-slate-400 text-sm">
          {userPosition
            ? `定位成功：${userPosition[0].toFixed(5)}, ${userPosition[1].toFixed(5)}`
            : "點擊 ⊕ 定位自己的位置，再按「新增地點」"}
        </p>

        <div className="h-64 w-full relative z-0">
          <MapContainer
            center={userPosition || defaultCenter}
            zoom={16}
            style={{ height: "100%", width: "100%" }}
            zoomControl={false}
          >
            {/* 切換圖層 */}
            {isStreetView ? (
              <TileLayer
                key="street"
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution='&copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a>'
              />
            ) : (
              <TileLayer
                key="satellite"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                attribution="Tiles &copy; Esri"
              />
            )}

            {/* 飛到 GPS 位置 */}
            <FlyToLocation position={flyTarget} />

            {/* 使用者位置 */}
            {userPosition && (
              <>
                <Circle
                  center={userPosition}
                  radius={30}
                  pathOptions={{
                    fillColor: "#3b82f6",
                    fillOpacity: 0.25,
                    color: "#3b82f6",
                    weight: 2,
                  }}
                />
                <Marker position={userPosition} />
              </>
            )}

            {/* 預設中心十字 marker（未定位時顯示） */}
            {!userPosition && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[1000] pointer-events-none flex flex-col items-center">
                <div className="w-8 h-8 bg-yellow-500/80 rounded-full flex items-center justify-center mb-1 border-2 border-white/50">
                  <div className="w-3 h-3 bg-white rounded-full"></div>
                </div>
                <div className="bg-slate-900/80 backdrop-blur-sm text-white px-4 py-1 rounded-full font-bold border border-slate-700">
                  Home
                </div>
              </div>
            )}
          </MapContainer>
        </div>

        <div className="p-4 bg-slate-900 border-t border-slate-800">
          <p className="text-slate-400">
            {userPosition ? "已取得 GPS 位置，可新增地點" : "尚未選取位置"}
          </p>
        </div>
      </div>

      {/* Manual Control */}
      <div className="bg-slate-900 mx-4 rounded-2xl p-4 border border-slate-800 mb-4">
        <h2 className="text-xl font-bold mb-4">手動控制</h2>
        <div className="grid grid-cols-3 gap-4">
          <button
            onClick={() => handleControl("open")}
            className="py-4 rounded-2xl border border-blue-500 text-blue-400 hover:bg-blue-500/10 font-bold text-lg transition-colors"
          >
            開
          </button>
          <button
            onClick={() => handleControl("stop")}
            className="py-4 rounded-2xl border border-red-500 text-red-400 hover:bg-red-500/10 font-bold text-lg transition-colors"
          >
            停
          </button>
          <button
            onClick={() => handleControl("down")}
            className="py-4 rounded-2xl border border-slate-600 text-slate-300 hover:bg-slate-800 font-bold text-lg transition-colors"
          >
            關
          </button>
        </div>
      </div>

      {/* Location Settings */}
      <div className="bg-slate-900 mx-4 rounded-2xl p-4 border border-slate-800">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">位置設定</h2>
          <button className="px-4 py-2 rounded-full border border-purple-500 text-purple-400 hover:bg-purple-500/10 text-sm transition-colors">
            付費說明
          </button>
        </div>
        <button className="w-full py-4 rounded-2xl border border-purple-600 bg-purple-900/20 text-white font-bold text-lg hover:bg-purple-900/40 transition-colors">
          新增地點
        </button>
      </div>

      {/* 設備帳密 Modal */}
      {showCredentials && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-xl font-bold mb-4">設備帳密</h3>
            {selectedDevice ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-slate-400 mb-1">帳號</label>
                  <div className="bg-slate-800 p-3 rounded-xl font-mono text-sm border border-slate-700">
                    {selectedDevice.mqtt_user || "未設定"}
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-slate-400 mb-1">密碼</label>
                  <div className="bg-slate-800 p-3 rounded-xl font-mono text-sm border border-slate-700">
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

      {/* 重置確認 Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-red-500/50 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-xl font-bold mb-2 text-red-400">確認重置</h3>
            <p className="text-slate-300 mb-1 text-sm">
              此操作將清除您帳號下的所有設備資料。
            </p>
            <p className="text-slate-400 text-xs mb-6">
              ⚠ 登入資格（registered_emails）不受影響，重置後仍可登入。
            </p>
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
                {resetting ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  "確認重置"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
