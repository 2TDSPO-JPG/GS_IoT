#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <esp_system.h>

constexpr int TRIG_PIN = 5;
constexpr int ECHO_PIN = 18;
constexpr unsigned long SAMPLE_INTERVAL_MS = 5000;
constexpr unsigned long RETRY_INTERVAL_MS = 5000;
constexpr char MQTT_HOST[] = "broker.hivemq.com";
constexpr uint16_t MQTT_PORT = 1883;
constexpr char MQTT_TOPIC[] = "saneia/demo/72f4a1ce9b/res07/telemetry";
constexpr char DEVICE_ID[] = "S07";

WiFiClient connection;
PubSubClient mqtt(connection);
char bootId[17];
char clientId[24];
unsigned long lastSample = 0;
unsigned long lastRetry = 0;
unsigned long sequence = 0;

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);
  snprintf(bootId, sizeof(bootId), "%08lx%08lx",
           (unsigned long)esp_random(), (unsigned long)esp_random());
  snprintf(clientId, sizeof(clientId), "saneia-%s", bootId);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin("Wokwi-GUEST", "", 6);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setSocketTimeout(3);
  mqtt.setBufferSize(256);
  Serial.println("Saneia RES-07. Clique no HC-SR04 para ajustar a distância.");
}

void sampleDistance() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  const unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000);
  if (duration == 0) {
    Serial.println("Sem eco. Nenhuma leitura publicada.");
    return;
  }
  const float distanceCm = duration / 58.0f;
  if (distanceCm < 2 || distanceCm > 400) {
    Serial.println("Distância fora da faixa do sensor.");
    return;
  }
  char payload[160];
  snprintf(payload, sizeof(payload),
    "{\"schemaVersion\":1,\"sensorId\":\"%s\",\"sampleId\":\"%s-%lu\",\"distanceCm\":%.2f}",
    DEVICE_ID, bootId, ++sequence, distanceCm);
  Serial.println(payload);
  if (mqtt.connected() && !mqtt.publish(MQTT_TOPIC, payload, false)) {
    Serial.println("Publicação falhou. A próxima medição será tentada.");
  }
}

void loop() {
  const unsigned long now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqtt.connected() && (lastRetry == 0 || now - lastRetry >= RETRY_INTERVAL_MS)) {
      lastRetry = now;
      if (mqtt.connect(clientId)) Serial.println("Conectado ao HiveMQ.");
      else Serial.printf("HiveMQ indisponível (código %d). Tentando novamente.\n", mqtt.state());
    }
    if (mqtt.connected()) mqtt.loop();
  }
  if (lastSample == 0 || now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    sampleDistance();
  }
  delay(20);
}
