import { log } from '../../utils/logger.js?v=0222';

// ==========================================
// MCP 工具管理逻辑
// ==========================================

// 全局变量
let mcpTools = [];
let mcpEditingIndex = null;
let mcpProperties = [];
let websocket = null; // 将从外部设置

/**
 * 设置 WebSocket 实例
 * @param {WebSocket} ws - WebSocket 连接实例
 */
export function setWebSocket(ws) {
    websocket = ws;
}

// 工具定义是异步 fetch 的，但唤醒词一喊就立刻连服务器、服务器立刻来要
// tools/list —— 这时候定义还没加载完，就会上报一个空列表，LLM 于是
// 一个工具都调不了（表现为"让她开/关相机，她只动嘴不动手"）。
// 这里暴露一个 promise，让响应方先等一等。
let markToolsReady;
export const toolsReady = new Promise((resolve) => { markToolsReady = resolve; });

/**
 * 初始化 MCP 工具
 */
export async function initMcpTools() {
    try {
        // 加载默认工具数据
        // 带版本参数，否则浏览器可能沿用旧的工具定义缓存
        const defaultMcpTools = await fetch("js/config/default-mcp-tools.json?v=0222").then(res => res.json());
        const savedTools = localStorage.getItem('mcpTools');
        if (savedTools) {
            try {
                const parsedTools = JSON.parse(savedTools);
                // 合并默认工具和用户保存的工具，保留用户自定义的工具
                const defaultToolNames = new Set(defaultMcpTools.map(t => t.name));
                // 添加默认工具中不存在的新工具
                parsedTools.forEach(tool => {
                    if (!defaultToolNames.has(tool.name)) {
                        defaultMcpTools.push(tool);
                    }
                });
            } catch (e) {
                log('合并本地工具失败，仅使用默认工具', 'warning');
            }
        }
        mcpTools = defaultMcpTools;
    } catch (e) {
        // 兜底：用上次存在本地的工具，总比一个都没有强
        log(`加载工具定义失败: ${e.message}`, 'error');
        try {
            mcpTools = JSON.parse(localStorage.getItem('mcpTools') || '[]');
        } catch (_) {
            mcpTools = [];
        }
    } finally {
        markToolsReady();
    }
    // 带上构建号：排查"浏览器是不是还在跑旧代码"时一眼可辨
    log(`[MCP] 工具已加载 ${mcpTools.length} 个 (build 0216)`, mcpTools.length ? 'success' : 'error');
    renderMcpTools();
    setupMcpEventListeners();
}

/**
 * 渲染工具列表
 */
function renderMcpTools() {
    const container = document.getElementById('mcpToolsContainer');
    const countSpan = document.getElementById('mcpToolsCount');
    if (!container) {
        return; // Container not found, skip rendering
    }
    if (countSpan) {
        countSpan.textContent = `${mcpTools.length} 个工具`;
    }
    if (mcpTools.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 30px; color: #999;">暂无工具，点击下方按钮添加新工具</div>';
        return;
    }
    container.innerHTML = mcpTools.map((tool, index) => {
        const paramCount = tool.inputSchema.properties ? Object.keys(tool.inputSchema.properties).length : 0;
        const requiredCount = tool.inputSchema.required ? tool.inputSchema.required.length : 0;
        const hasMockResponse = tool.mockResponse && Object.keys(tool.mockResponse).length > 0;
        return `
            <div class="mcp-tool-card">
                <div class="mcp-tool-header">
                    <div class="mcp-tool-name">${tool.name}</div>
                    <div class="mcp-tool-actions">
                        <button class="mcp-edit-btn" onclick="window.mcpModule.editMcpTool(${index})">
                            ✏️ 编辑
                        </button>
                        <button class="mcp-delete-btn" onclick="window.mcpModule.deleteMcpTool(${index})">
                            🗑️ 删除
                        </button>
                    </div>
                </div>
                <div class="mcp-tool-description">${tool.description}</div>
                <div class="mcp-tool-info">
                    <div class="mcp-tool-info-row">
                        <span class="mcp-tool-info-label">参数数量:</span>
                        <span class="mcp-tool-info-value">${paramCount} 个 ${requiredCount > 0 ? `(${requiredCount} 个必填)` : ''}</span>
                    </div>
                    <div class="mcp-tool-info-row">
                        <span class="mcp-tool-info-label">模拟返回:</span>
                        <span class="mcp-tool-info-value">${hasMockResponse ? '✅ 已配置: ' + JSON.stringify(tool.mockResponse) : '⚪ 使用默认'}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

/**
 * 渲染参数列表
 */
function renderMcpProperties() {
    const container = document.getElementById('mcpPropertiesContainer');
    const emptyState = document.getElementById('mcpEmptyState');
    if (!container) {
        return; // Container not found, skip rendering
    }
    if (mcpProperties.length === 0) {
        if (emptyState) {
            emptyState.style.display = 'block';
        }
        container.innerHTML = '';
        return;
    }
    if (emptyState) {
        emptyState.style.display = 'none';
    }
    container.innerHTML = mcpProperties.map((prop, index) => `
        <div class="mcp-property-card" onclick="window.mcpModule.editMcpProperty(${index})">
            <div class="mcp-property-row-label">
                <span class="mcp-property-label">参数名称</span>
                <span class="mcp-property-value">${prop.name}${prop.required ? ' <span class="mcp-property-required-badge">[必填]</span>' : ''}</span>
            </div>
            <div class="mcp-property-row-label">
                <span class="mcp-property-label">数据类型</span>
                <span class="mcp-property-value">${getTypeLabel(prop.type)}</span>
            </div>
            <div class="mcp-property-row-label">
                <span class="mcp-property-label">描述</span>
                <span class="mcp-property-value">${prop.description || '-'}</span>
            </div>
            <div class="mcp-property-row-action">
                <button class="mcp-property-delete-btn" onclick="event.stopPropagation(); window.mcpModule.deleteMcpProperty(${index})">删除</button>
            </div>
        </div>
    `).join('');
}

/**
 * 获取数据类型标签
 */
function getTypeLabel(type) {
    const typeMap = {
        'string': '字符串',
        'integer': '整数',
        'number': '数字',
        'boolean': '布尔值',
        'array': '数组',
        'object': '对象'
    };
    return typeMap[type] || type;
}

/**
 * 添加参数 - 打开参数编辑模态框
 */
function addMcpProperty() {
    openPropertyModal();
}

/**
 * 编辑参数 - 打开参数编辑模态框
 */
function editMcpProperty(index) {
    openPropertyModal(index);
}

/**
 * 打开参数编辑模态框
 */
function openPropertyModal(index = null) {
    const form = document.getElementById('mcpPropertyForm');
    const title = document.getElementById('mcpPropertyModalTitle');
    document.getElementById('mcpPropertyIndex').value = index !== null ? index : -1;

    if (index !== null) {
        const prop = mcpProperties[index];
        title.textContent = '编辑参数';
        document.getElementById('mcpPropertyName').value = prop.name;
        document.getElementById('mcpPropertyType').value = prop.type || 'string';
        document.getElementById('mcpPropertyMinimum').value = prop.minimum !== undefined ? prop.minimum : '';
        document.getElementById('mcpPropertyMaximum').value = prop.maximum !== undefined ? prop.maximum : '';
        document.getElementById('mcpPropertyDescription').value = prop.description || '';
        document.getElementById('mcpPropertyRequired').checked = prop.required || false;
    } else {
        title.textContent = '添加参数';
        form.reset();
        document.getElementById('mcpPropertyName').value = `param_${mcpProperties.length + 1}`;
        document.getElementById('mcpPropertyType').value = 'string';
        document.getElementById('mcpPropertyMinimum').value = '';
        document.getElementById('mcpPropertyMaximum').value = '';
        document.getElementById('mcpPropertyDescription').value = '';
        document.getElementById('mcpPropertyRequired').checked = false;
    }

    updatePropertyRangeVisibility();
    document.getElementById('mcpPropertyModal').style.display = 'flex';
}

/**
 * 关闭参数编辑模态框
 */
function closePropertyModal() {
    document.getElementById('mcpPropertyModal').style.display = 'none';
}

/**
 * 更新数值范围输入框的可见性
 */
function updatePropertyRangeVisibility() {
    const type = document.getElementById('mcpPropertyType').value;
    const rangeGroup = document.getElementById('mcpPropertyRangeGroup');
    if (type === 'integer' || type === 'number') {
        rangeGroup.style.display = 'block';
    } else {
        rangeGroup.style.display = 'none';
    }
}

/**
 * 处理参数表单提交
 */
function handlePropertySubmit(e) {
    e.preventDefault();
    const index = parseInt(document.getElementById('mcpPropertyIndex').value);
    const name = document.getElementById('mcpPropertyName').value.trim();
    const type = document.getElementById('mcpPropertyType').value;
    const minimum = document.getElementById('mcpPropertyMinimum').value;
    const maximum = document.getElementById('mcpPropertyMaximum').value;
    const description = document.getElementById('mcpPropertyDescription').value.trim();
    const required = document.getElementById('mcpPropertyRequired').checked;

    // 检查名称重复
    const isDuplicate = mcpProperties.some((p, i) => i !== index && p.name === name);
    if (isDuplicate) {
        alert('参数名称已存在，请使用不同的名称');
        return;
    }

    const propData = {
        name,
        type,
        description,
        required
    };

    // 数值类型添加范围限制
    if (type === 'integer' || type === 'number') {
        if (minimum !== '') {
            propData.minimum = parseFloat(minimum);
        }
        if (maximum !== '') {
            propData.maximum = parseFloat(maximum);
        }
    }

    if (index >= 0) {
        mcpProperties[index] = propData;
    } else {
        mcpProperties.push(propData);
    }

    renderMcpProperties();
    closePropertyModal();
}

/**
 * 删除参数
 */
function deleteMcpProperty(index) {
    mcpProperties.splice(index, 1);
    renderMcpProperties();
}

/**
 * 设置事件监听
 */
function setupMcpEventListeners() {
    const panel = document.getElementById('mcpToolsPanel');
    const addBtn = document.getElementById('addMcpToolBtn');
    const modal = document.getElementById('mcpToolModal');
    const closeBtn = document.getElementById('closeMcpModalBtn');
    const cancelBtn = document.getElementById('cancelMcpBtn');
    const form = document.getElementById('mcpToolForm');
    const addPropertyBtn = document.getElementById('addMcpPropertyBtn');

    // 参数编辑模态框相关元素
    const propertyModal = document.getElementById('mcpPropertyModal');
    const closePropertyBtn = document.getElementById('closeMcpPropertyModalBtn');
    const cancelPropertyBtn = document.getElementById('cancelMcpPropertyBtn');
    const propertyForm = document.getElementById('mcpPropertyForm');
    const propertyTypeSelect = document.getElementById('mcpPropertyType');

    // Return early if required elements don't exist (e.g., in test environment)
    if (!panel || !addBtn || !modal || !closeBtn || !cancelBtn || !form || !addPropertyBtn) {
        return;
    }
    addBtn.addEventListener('click', () => openMcpModal());
    closeBtn.addEventListener('click', closeMcpModal);
    cancelBtn.addEventListener('click', closeMcpModal);
    addPropertyBtn.addEventListener('click', addMcpProperty);
    form.addEventListener('submit', handleMcpSubmit);

    // 参数编辑模态框事件
    if (propertyModal && closePropertyBtn && cancelPropertyBtn && propertyForm && propertyTypeSelect) {
        closePropertyBtn.addEventListener('click', closePropertyModal);
        cancelPropertyBtn.addEventListener('click', closePropertyModal);
        propertyForm.addEventListener('submit', handlePropertySubmit);
        propertyTypeSelect.addEventListener('change', updatePropertyRangeVisibility);
    }
}

/**
 * 打开模态框
 */
function openMcpModal(index = null) {
    const isConnected = websocket && websocket.readyState === WebSocket.OPEN;
    if (isConnected) {
        alert('WebSocket 已连接，无法编辑工具');
        return;
    }
    mcpEditingIndex = index;
    const errorContainer = document.getElementById('mcpErrorContainer');
    errorContainer.innerHTML = '';
    if (index !== null) {
        document.getElementById('mcpModalTitle').textContent = '编辑工具';
        const tool = mcpTools[index];
        document.getElementById('mcpToolName').value = tool.name;
        document.getElementById('mcpToolDescription').value = tool.description;
        document.getElementById('mcpMockResponse').value = tool.mockResponse ? JSON.stringify(tool.mockResponse, null, 2) : '';
        mcpProperties = [];
        const schema = tool.inputSchema;
        if (schema.properties) {
            Object.keys(schema.properties).forEach(key => {
                const prop = schema.properties[key];
                mcpProperties.push({
                    name: key,
                    type: prop.type || 'string',
                    minimum: prop.minimum,
                    maximum: prop.maximum,
                    description: prop.description || '',
                    required: schema.required && schema.required.includes(key)
                });
            });
        }
    } else {
        document.getElementById('mcpModalTitle').textContent = '添加工具';
        document.getElementById('mcpToolForm').reset();
        mcpProperties = [];
    }
    renderMcpProperties();
    document.getElementById('mcpToolModal').style.display = 'flex';
}

/**
 * 关闭模态框
 */
function closeMcpModal() {
    document.getElementById('mcpToolModal').style.display = 'none';
    mcpEditingIndex = null;
    document.getElementById('mcpToolForm').reset();
    mcpProperties = [];
    document.getElementById('mcpErrorContainer').innerHTML = '';
}

/**
 * 处理表单提交
 */
function handleMcpSubmit(e) {
    e.preventDefault();
    const errorContainer = document.getElementById('mcpErrorContainer');
    errorContainer.innerHTML = '';
    const name = document.getElementById('mcpToolName').value.trim();
    const description = document.getElementById('mcpToolDescription').value.trim();
    const mockResponseText = document.getElementById('mcpMockResponse').value.trim();
    // 检查名称重复
    const isDuplicate = mcpTools.some((tool, index) => tool.name === name && index !== mcpEditingIndex);
    if (isDuplicate) {
        showMcpError('工具名称已存在，请使用不同的名称');
        return;
    }
    // 解析模拟返回结果
    let mockResponse = null;
    if (mockResponseText) {
        try {
            mockResponse = JSON.parse(mockResponseText);
        } catch (e) {
            showMcpError('模拟返回结果不是有效的 JSON 格式: ' + e.message);
            return;
        }
    }
    // 构建 inputSchema
    const inputSchema = { type: "object", properties: {}, required: [] };
    mcpProperties.forEach(prop => {
        const propSchema = { type: prop.type };
        if (prop.description) {
            propSchema.description = prop.description;
        }
        if ((prop.type === 'integer' || prop.type === 'number')) {
            if (prop.minimum !== undefined && prop.minimum !== '') {
                propSchema.minimum = prop.minimum;
            }
            if (prop.maximum !== undefined && prop.maximum !== '') {
                propSchema.maximum = prop.maximum;
            }
        }
        inputSchema.properties[prop.name] = propSchema;
        if (prop.required) {
            inputSchema.required.push(prop.name);
        }
    });
    if (inputSchema.required.length === 0) {
        delete inputSchema.required;
    }
    const tool = { name, description, inputSchema, mockResponse };
    if (mcpEditingIndex !== null) {
        mcpTools[mcpEditingIndex] = tool;
        log(`已更新工具: ${name}`, 'success');
    } else {
        mcpTools.push(tool);
        log(`已添加工具: ${name}`, 'success');
    }
    saveMcpTools();
    renderMcpTools();
    closeMcpModal();
}

/**
 * 显示错误
 */
function showMcpError(message) {
    const errorContainer = document.getElementById('mcpErrorContainer');
    errorContainer.innerHTML = `<div class="mcp-error">${message}</div>`;
}

/**
 * 编辑工具
 */
function editMcpTool(index) {
    openMcpModal(index);
}

/**
 * 删除工具
 */
function deleteMcpTool(index) {
    const isConnected = websocket && websocket.readyState === WebSocket.OPEN;
    if (isConnected) {
        alert('WebSocket 已连接，无法编辑工具');
        return;
    }
    if (confirm(`确定要删除工具 "${mcpTools[index].name}" 吗？`)) {
        const toolName = mcpTools[index].name;
        mcpTools.splice(index, 1);
        saveMcpTools();
        renderMcpTools();
        log(`已删除工具: ${toolName}`, 'info');
    }
}

/**
 * 保存工具
 */
function saveMcpTools() {
    localStorage.setItem('mcpTools', JSON.stringify(mcpTools));
}

/**
 * 获取工具列表
 */
export function getMcpTools() {
    return mcpTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
}

/**
 * 写入工具列表（供 websocket.js 在 getMcpTools 意外为空时兜底）。
 * 必须走这里而不是直接改外部数组，才能保证和 executeMcpTool 用同一份状态。
 */
export function setMcpTools(list) {
    if (Array.isArray(list) && list.length) {
        mcpTools = list;
        log(`[MCP] 兜底写入 ${mcpTools.length} 个工具`, 'success');
    }
}

/**
 * 执行工具调用
 */
export async function executeMcpTool(toolName, toolArgs) {
    const tool = mcpTools.find(t => t.name === toolName);
    if (!tool) {
        log(`未找到工具: ${toolName}`, 'error');
        return { success: false, error: `未知工具: ${toolName}` };
    }

    // 拍照并存到本地照片目录（落盘由唤醒词服务的 /save-photo 负责，
    // 网页本身写不了 D:\Project\照片，见 wakeword_runtime/runtime/http_server.py）
    if (toolName === 'self_camera_snapshot') {
        if (typeof window.takePhoto !== 'function') {
            return { success: false, error: '摄像头未启动，请先开启相机' };
        }
        const question = (toolArgs && toolArgs.question) || '用一句话描述这张照片';
        const shot = await window.takePhoto(question);
        if (!shot || !shot.photo_data) {
            return { success: false, error: (shot && shot.error) || '拍照失败' };
        }
        try {
            // photo_data 是 data:image/jpeg;base64,... ，转成二进制再 POST
            const blob = await (await fetch(shot.photo_data)).blob();
            const res = await fetch('/save-photo', {
                method: 'POST',
                headers: { 'Content-Type': 'image/jpeg' },
                body: blob,
            });
            const saved = await res.json();
            if (!saved.success) throw new Error(saved.error || '保存失败');
            log(`照片已保存: ${saved.name} (${saved.bytes} 字节)`, 'success');
            const desc = shot.vision_analysis && shot.vision_analysis.response;
            return {
                success: true,
                saved_as: saved.name,
                vision_analysis: shot.vision_analysis,
                message: `照片已保存为 ${saved.name}${desc ? '，画面：' + desc : ''}`,
            };
        } catch (e) {
            log(`照片保存失败: ${e.message}`, 'error');
            return { success: false, error: `拍照成功但保存失败: ${e.message}` };
        }
    }

    // 语音开关相机（模块见 js/core/camera-glance.js）
    if (toolName === 'self_camera_open') {
        if (!window.jiajiaCamera) {
            return { success: false, error: '相机控制模块未加载' };
        }
        const r = await window.jiajiaCamera.open();
        log(`语音开启相机: ${r.message || r.error}`, r.success ? 'success' : 'error');
        return r;
    }

    if (toolName === 'self_camera_close') {
        if (!window.jiajiaCamera) {
            return { success: false, error: '相机控制模块未加载' };
        }
        const r = window.jiajiaCamera.close();
        log(`语音关闭相机: ${r.message}`, 'success');
        return r;
    }

    // 开相机 ≠ 会自动瞥视，得再单独说一句「开始实时观看」
    if (toolName === 'self_camera_start_watching') {
        if (!window.jiajiaCamera) {
            return { success: false, error: '相机控制模块未加载' };
        }
        const r = await window.jiajiaCamera.startWatching();
        log(`语音开始实时观看: ${r.message || r.error}`, r.success ? 'success' : 'error');
        return r;
    }

    if (toolName === 'self_camera_stop_watching') {
        if (!window.jiajiaCamera) {
            return { success: false, error: '相机控制模块未加载' };
        }
        const r = window.jiajiaCamera.stopWatching();
        log(`语音停止实时观看: ${r.message}`, 'success');
        return r;
    }

    // 处理拍照工具
    if (toolName === 'self_camera_take_photo') {
        if (typeof window.takePhoto === 'function') {
            const question = toolArgs && toolArgs.question ? toolArgs.question : '描述一下看到的物品';
            log(`正在执行拍照: ${question}`, 'info');
            const result = await window.takePhoto(question);
            return result;
        } else {
            log('拍照功能不可用', 'warning');
            return { success: false, error: '摄像头未启动或不支持拍照功能' };
        }
    }

    // 如果有模拟返回结果，使用它
    if (tool.mockResponse) {
        // 替换模板变量
        let responseStr = JSON.stringify(tool.mockResponse);
        // 替换 ${paramName} 格式的变量
        if (toolArgs) {
            Object.keys(toolArgs).forEach(key => {
                const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
                responseStr = responseStr.replace(regex, toolArgs[key]);
            });
        }
        try {
            const response = JSON.parse(responseStr);
            log(`工具 ${toolName} 执行成功，返回模拟结果: ${responseStr}`, 'success');
            return response;
        } catch (e) {
            log(`解析模拟返回结果失败: ${e.message}`, 'error');
            return tool.mockResponse;
        }
    }
    // 没有模拟返回结果，返回默认成功消息
    log(`工具 ${toolName} 执行成功，返回默认结果`, 'success');
    return { success: true, message: `工具 ${toolName} 执行成功`, tool: toolName, arguments: toolArgs };
}

// 暴露全局方法供 HTML 内联事件调用
window.mcpModule = { addMcpProperty, editMcpProperty, deleteMcpProperty, editMcpTool, deleteMcpTool };
