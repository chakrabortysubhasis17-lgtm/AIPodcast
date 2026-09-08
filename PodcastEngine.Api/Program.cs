using PodcastEngine.Api.Services;

var builder = WebApplication.CreateBuilder(args);

// Explicitly bind Kestrel to HTTP on port 5000 only
builder.WebHost.UseUrls("http://localhost:5000");

builder.Services.AddControllers();
builder.Services.AddSingleton<PodcastPipelineService>();
builder.Services.AddSingleton<PodcastEngine.Api.Services.JobProgressService>();
builder.Services.AddCors(opts => {
    opts.AddDefaultPolicy(policy => policy
        .AllowAnyOrigin()
        .AllowAnyMethod()
        .AllowAnyHeader());
});

builder.Services.AddCors(options => {
    options.AddPolicy("AllowAngularApp", policy => {
        policy.WithOrigins("http://localhost:4200")
              .AllowAnyHeader()
              .AllowAnyMethod()
              .AllowCredentials();
    });
});
var app = builder.Build();

app.UseCors();
app.MapControllers();

app.Run();
